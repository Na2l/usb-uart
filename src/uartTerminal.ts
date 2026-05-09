import * as vscode from 'vscode';
import { UartManager } from './uartManager';
import { MicroPythonUploader } from './micropythonUploader';
import { MicroPythonPager } from './micropythonPager';
import { log } from './extension';

export class UartTerminal implements vscode.Pseudoterminal {
    private readonly _onDidWrite = new vscode.EventEmitter<string>();
    readonly onDidWrite = this._onDidWrite.event;

    private readonly _onDidClose = new vscode.EventEmitter<number | void>();
    readonly onDidClose = this._onDidClose.event;

    private disposables: vscode.Disposable[] = [];
    private dataDisposable: vscode.Disposable | undefined;
    private rxBuffer = '';
    private promptTimer: ReturnType<typeof setTimeout> | undefined;

    /** Locally buffered input line — sent to UART only on Enter. */
    private inputLine = '';
    /** Tracks the length of the last drawn MicroPython input line for clearing. */
    private lastDrawnLength = 0;
    /** Tracks what the user is typing in MicroPython pass-through mode for shortcut expansion. */
    private mpyInputLine = '';
    /** When set, the next Enter confirms (y/yes) or cancels the pending command. */
    private pendingConfirm: string | undefined = undefined;
    /** Command history for MicroPython mode. */
    private history: string[] = [];
    /** Current position while navigating history (-1 = not navigating). */
    private historyIndex = -1;
    /** Saved draft line while browsing history. */
    private historyDraft = '';
    /** Cursor position within mpyInputLine (0 = start, mpyInputLine.length = end) */
    private mpyCursor = 0;

    /** Terminal dimensions — updated by setDimensions. */
    private rows = 24;
    private cols = 80;

    /** Active pager session, or undefined when not in pager mode. */
    private pager: MicroPythonPager | undefined;

    /** Updated externally when port settings change. */
    lineEnding: 'cr' | 'lf' | 'crlf' = 'cr';
    terminalMode: 'uart' | 'micropython' = 'uart';

    setDimensions(dimensions: vscode.TerminalDimensions): void {
        this.rows = dimensions.rows;
        this.cols = dimensions.columns;
        this.pager?.setDimensions(dimensions.rows, dimensions.columns);
    }

    private _paused = false;

    /** Suppress forwarding incoming data to the terminal display.
     *  Used during raw-REPL operations (e.g. file upload). */
    pause():  void { this._paused = true; }
    resume(): void { this._paused = false; }

    // Strips DEC private mode sequences (e.g. bracketed paste \x1b[?2004h/l)
    // Keeps color/SGR sequences so colored output still renders.
    private static readonly DEC_PRIVATE_RE = /\x1b\[\?[0-9;]*[hl]/g;

    private preprocess(raw: string): string {
        return raw
            .replace(UartTerminal.DEC_PRIVATE_RE, '') // remove bracketed-paste and other DEC private modes
            .replace(/\r\n/g, '\n')                   // normalize CRLF
            .replace(/\r/g, '\n');                    // treat bare CR as newline (common on embedded devices)
    }

    constructor(
        private readonly uart: UartManager,
        private readonly portPath: string,
        private readonly label: string
    ) {}

    open(): void {
        this.write('\x1b[1;32m── Serial Terminal ──\x1b[0m\r\n');
        this.write(`${this.label}\r\n`);
        this.write('─'.repeat(42) + '\r\n');

        this.subscribeToData();
        // Nudge device to show its prompt on first open
        this.uart.write(this.portPath, '\r').catch(() => {});
        if (this.terminalMode !== 'micropython') { this.writePrompt(); }

        this.disposables.push(
            this.uart.onConnectionChanged(changedPath => {
                if (changedPath !== this.portPath) { return; }
                if (this.uart.isConnected(this.portPath)) {
                    // Reconnected — re-subscribe to the new session's data emitter
                    this.subscribeToData();
                    this.write('\r\n\x1b[1;32m[UART Connected]\x1b[0m\r\n');
                    // Nudge device to show its prompt
                    this.uart.write(this.portPath, '\r').catch(() => {});
                    if (this.terminalMode !== 'micropython') { this.writePrompt(); }
                } else {
                    this.dataDisposable?.dispose();
                    this.dataDisposable = undefined;
                    this.cancelFlush();
                    this.rxBuffer = '';
                    this.inputLine = '';
                    this.mpyInputLine = '';
                    this.pendingConfirm = undefined;
                    this.pager = undefined;
                    this.write('\r\n\x1b[1;31m[UART disconnected]\x1b[0m\r\n');
                }
            })
        );
    }

    private subscribeToData(): void {
        this.dataDisposable?.dispose();
        this.dataDisposable = this.uart.onData(this.portPath)(data => {
            if (this._paused) { return; }
            this.rxBuffer += this.preprocess(new TextDecoder().decode(data));
            while (true) {
                const idx = this.rxBuffer.indexOf('\n');
                if (idx === -1) { break; }
                const line = this.rxBuffer.slice(0, idx);
                this.rxBuffer = this.rxBuffer.slice(idx + 1);
                this.printReceived(line + '\r\n');
            }
            // Flush partial lines (device prompts with no newline) after silence
            this.scheduleFlush(150);
        });
    }

    handleInput(data: string): void {
        if (!this.uart.isConnected(this.portPath)) { return; }
        // Route all input to the pager when active
        if (this.pager) {
            this.pager.handleInput(data);
            return;
        }
        if (this.terminalMode === 'micropython') {
            // Handle escape sequences (arrow keys, etc.) as complete units before
            // falling through to character-by-character processing.
            if (data.startsWith('\x1b')) {
                if (data === '\x1b[A') { // Up arrow — history back
                    if (this.history.length === 0) { return; }
                    if (this.historyIndex === -1) {
                        this.historyDraft = this.mpyInputLine;
                        this.historyIndex = this.history.length - 1;
                    } else if (this.historyIndex > 0) {
                        this.historyIndex--;
                    }
                    this.setMpyLine(this.history[this.historyIndex]);
                } else if (data === '\x1b[B') { // Down arrow — history forward
                    if (this.historyIndex === -1) { return; }
                    if (this.historyIndex < this.history.length - 1) {
                        this.historyIndex++;
                        this.setMpyLine(this.history[this.historyIndex]);
                    } else {
                        this.historyIndex = -1;
                        this.setMpyLine(this.historyDraft);
                    }
                } else if (data === '\x1b[D') { // Left arrow
                    if (this.mpyCursor > 0) {
                        this.mpyCursor--;
                        // Move cursor left: \x1b[D
                        this.write('\x1b[D');
                    }
                } else if (data === '\x1b[C') { // Right arrow
                    if (this.mpyCursor < this.mpyInputLine.length) {
                        this.mpyCursor++;
                        // Move cursor right: \x1b[C
                        this.write('\x1b[C');
                    }
                }
                // All other escape sequences (e.g. Ctrl+arrow, F-keys) are ignored.
                return;
            }
            for (const ch of data) {
                // Control characters (Ctrl+C, Ctrl+D, Ctrl+B, Ctrl+A, etc.) bypass
                // the line buffer and are sent to the device immediately.
                if (ch < '\x20' && ch !== '\r' && ch !== '\x7f' && ch !== '\x08') {
                    this.mpyInputLine = '';
                    this.mpyCursor = 0;
                    if (this.pendingConfirm !== undefined) {
                        this.pendingConfirm = undefined;
                        this.write('\r\n\x1b[1;33mFormat cancelled.\x1b[0m\r\n');
                    }
                    this.uart.write(this.portPath, ch)
                        .catch(e => log.appendLine(`[Serial] Terminal write error: ${e}`));
                    continue;
                }
                if (ch === '\r') {
                    const config = vscode.workspace.getConfiguration('usb-local');
                    const defaults = config.inspect<Record<string, string>>('micropythonShortcuts')?.defaultValue ?? {};
                    const user = config.get<Record<string, string>>('micropythonShortcuts') ?? {};
                    const shortcuts: Record<string, string> = { ...defaults, ...user };
                    const trimmed = this.mpyInputLine.trim();
                    const parts = trimmed.split(/\s+/);
                    const key = parts[0];
                    const arg1 = parts.slice(1).join(' ');
                    this.mpyInputLine = '';
                    this.mpyCursor = 0;
                    this.historyIndex = -1;
                    this.historyDraft = '';
                    this.write('\r\n');
                    // Handle confirmation prompt response
                    if (this.pendingConfirm !== undefined) {
                        const answer = trimmed.toLowerCase();
                        if (answer === 'y' || answer === 'yes') {
                            const cmd = this.pendingConfirm;
                            this.pendingConfirm = undefined;
                            this.uart.write(this.portPath, cmd + '\r')
                                .catch(e => log.appendLine(`[Serial] Terminal write error: ${e}`));
                        } else {
                            this.pendingConfirm = undefined;
                            this.write('\x1b[1;33mFormat cancelled.\x1b[0m\r\n');
                            this.uart.write(this.portPath, '\r').catch(() => {});
                        }
                        continue;
                    }                    if (trimmed === 'alias') {
                        const entries = Object.entries(shortcuts);
                        if (entries.length === 0) {
                            this.write('\x1b[1;33mNo aliases defined.\x1b[0m\r\n');
                        } else {
                            this.write('\x1b[1;33mAliases:\x1b[0m\r\n');
                            const maxLen = Math.max(...entries.map(([k]) => k.length));
                            for (const [k, v] of entries) {
                                this.write(`  alias \x1b[1;36m${k.padEnd(maxLen)}\x1b[0m='${v}'\r\n`);
                            }
                        }
                        // Nudge device to re-display its prompt
                        this.uart.write(this.portPath, '\r').catch(() => {});
                    } else if (trimmed === 'format') {
                        const formatCmd = shortcuts['format'] ??
                            "import os; os.mkfs('/')\; print('Filesystem formatted.')";
                        this.pendingConfirm = formatCmd;
                        this.write('\x1b[1;31mWarning: this will delete everything on the device filesystem.\x1b[0m\r\n');
                        this.write('Are you sure? [y/N]: ');
                    } else if (key === 'less') {
                        const file = arg1.replace(/^'|'$/g, '');
                        if (!file) {
                            this.write('\x1b[1;31mUsage: less <filename>\x1b[0m\r\n');
                            this.uart.write(this.portPath, '\r').catch(() => {});
                        } else {
                            this.openLess(file);
                        }
                    } else {
                        let expanded: string;
                        const tpl = shortcuts[trimmed] ?? shortcuts[key];
                        if (tpl !== undefined) {
                            expanded = tpl.replace('$1', arg1 ? `'${arg1}'` : '');
                        } else {
                            expanded = trimmed;
                        }
                        if (trimmed) {
                            this.history.push(trimmed);
                            if (this.history.length > 200) { this.history.shift(); }
                        }
                        this.uart.write(this.portPath, expanded + '\r')
                            .catch(e => log.appendLine(`[Serial] Terminal write error: ${e}`));
                    }
                } else if (ch === '\x7f' || ch === '\x08') {
                    if (this.mpyInputLine.length > 0 && this.mpyCursor > 0) {
                        // Remove character before cursor
                        this.mpyInputLine = this.mpyInputLine.slice(0, this.mpyCursor - 1) + this.mpyInputLine.slice(this.mpyCursor);
                        this.mpyCursor--;
                        // Redraw line
                        this.redrawMpyLine();
                    }
                } else if (ch >= ' ') {
                    // Insert character at cursor
                    this.mpyInputLine = this.mpyInputLine.slice(0, this.mpyCursor) + ch + this.mpyInputLine.slice(this.mpyCursor);
                    this.mpyCursor++;
                    // Redraw line
                    this.redrawMpyLine();
                }
            }
            return;
        }
        // UART mode: line-buffered with local echo
        const le = this.lineEnding === 'lf' ? '\n' : this.lineEnding === 'crlf' ? '\r\n' : '\r';
        for (const ch of data) {
            if (ch === '\r') {
                // Enter — echo newline, send buffered line to UART
                this.write('\r\n');
                const toSend = this.inputLine + le;
                this.inputLine = '';
                this.uart.write(this.portPath, toSend).catch(e => log.appendLine(`[Serial] Terminal write error: ${e}`));
                this.writePrompt();
            } else if (ch === '\x7f' || ch === '\x08') {
                // Backspace — erase last character from local buffer and display
                if (this.inputLine.length > 0) {
                    this.inputLine = this.inputLine.slice(0, -1);
                    this.write('\x08 \x08');
                }
            } else if (ch >= ' ') {
                // Printable character — buffer and echo locally
                this.inputLine += ch;
                this.write(ch);
            }
        }
    }

    close(): void {
        this.cancelFlush();
        this.dataDisposable?.dispose();
        this.dataDisposable = undefined;
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
    }

    private scheduleFlush(delay: number): void {
        this.cancelFlush();
        this.promptTimer = setTimeout(() => {
            this.promptTimer = undefined;
            if (this.rxBuffer.length > 0) {
                this.printReceived(this.rxBuffer);
                this.rxBuffer = '';
            }
        }, delay);
    }

    private cancelFlush(): void {
        if (this.promptTimer !== undefined) {
            clearTimeout(this.promptTimer);
            this.promptTimer = undefined;
        }
    }

    private openLess(remotePath: string): void {
        this.write(`\x1b[1;33mLoading ${remotePath}…\x1b[0m\r\n`);
        this.pause();
        const uploader = new MicroPythonUploader(this.uart);
        let lastPct = -1;
        uploader.readFile(this.portPath, remotePath, (read, total) => {
            const pct = Math.round((read / total) * 100);
            if (pct !== lastPct) {
                lastPct = pct;
                this.write(`\r\x1b[K\x1b[1;33mLoading ${remotePath}… ${pct}%\x1b[0m`);
            }
        }).then(content => {
            this.resume();
            this.write('\r\n');
            this.pager = new MicroPythonPager(
                content, this.rows, this.cols, remotePath,
                (text) => this.write(text),
                () => {
                    this.pager = undefined;
                    this.uart.write(this.portPath, '\r').catch(() => {});
                }
            );
            this.pager.open();
        }).catch(e => {
            this.resume();
            this.write(`\r\n\x1b[1;31mError reading ${remotePath}: ${e}\x1b[0m\r\n`);
            this.uart.write(this.portPath, '\r').catch(() => {});
        });
    }

    private write(text: string): void {
        this._onDidWrite.fire(text);
    }

    /** Replace the current MicroPython input line with `line`, updating display and cursor. */
    private setMpyLine(line: string): void {
        // Redraw prompt and line, reset cursor to end
        this.write(`\r`); // Move to start of line
        this.write(this.getPrompt());
        this.write(line);
        // Clear any extra characters from previous input
        if (this.lastDrawnLength > line.length) {
            this.write(' '.repeat(this.lastDrawnLength - line.length));
        }
        this.mpyInputLine = line;
        this.mpyCursor = line.length;
        this.lastDrawnLength = line.length;
    }

    /** Redraw the MicroPython input line and move the cursor to the correct position. */
    private redrawMpyLine(): void {
        // Redraw prompt and input line
        this.write(`\r`); // Move to start of line
        this.write(this.getPrompt());
        this.write(this.mpyInputLine);
        // Clear any extra characters from previous input
        if (this.mpyInputLine.length < this.lastDrawnLength) {
            this.write(' '.repeat(this.lastDrawnLength - this.mpyInputLine.length));
        }
        this.lastDrawnLength = this.mpyInputLine.length;
        // Move cursor to correct position
        const promptLen = this.getPrompt().length;
        const targetCol = promptLen + this.mpyCursor;
        const currentCol = promptLen + this.mpyInputLine.length;
        if (targetCol < currentCol) {
            this.write(`\x1b[${currentCol - targetCol}D`);
        }
    }

    /** Returns the MicroPython prompt string. */
    private getPrompt(): string {
        return '>>> ';
    }

    private writePrompt(): void {
        this.write('\x1b[1;33m>\x1b[0m ');
    }

    /**
     * Print received data atomically: erase the current input line, print the
     * data, then restore the prompt + any buffered input in a single fire() so
     * the terminal never renders a partial state.
     */
    private printReceived(text: string): void {
        if (this.terminalMode === 'uart') {
            const prompt = '\x1b[1;33m>\x1b[0m ';
            this._onDidWrite.fire('\x1b[2K\r' + text + prompt + this.inputLine);
        } else {
            this.write(text);
        }
    }
}
