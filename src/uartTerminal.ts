import * as vscode from 'vscode';
import { UartManager } from './uartManager';
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
    /** Tracks what the user is typing in MicroPython pass-through mode for shortcut expansion. */
    private mpyInputLine = '';

    /** Updated externally when port settings change. */
    lineEnding: 'cr' | 'lf' | 'crlf' = 'cr';
    terminalMode: 'uart' | 'micropython' = 'uart';

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
        if (this.terminalMode === 'micropython') {
            // In MicroPython mode intercept Enter to expand shortcuts,
            // otherwise pass every character straight through.
            for (const ch of data) {
                if (ch === '\r') {
                    const shortcuts: Record<string, string> =
                        vscode.workspace.getConfiguration('usb-local').get('micropythonShortcuts') ?? {};
                    const expanded = shortcuts[this.mpyInputLine.trim()] ?? this.mpyInputLine;
                    this.mpyInputLine = '';
                    this.uart.write(this.portPath, expanded + '\r')
                        .catch(e => log.appendLine(`[Serial] Terminal write error: ${e}`));
                } else if (ch === '\x7f' || ch === '\x08') {
                    this.mpyInputLine = this.mpyInputLine.slice(0, -1);
                    this.uart.write(this.portPath, ch)
                        .catch(e => log.appendLine(`[Serial] Terminal write error: ${e}`));
                } else {
                    this.mpyInputLine += ch;
                    this.uart.write(this.portPath, ch)
                        .catch(e => log.appendLine(`[Serial] Terminal write error: ${e}`));
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

    private write(text: string): void {
        this._onDidWrite.fire(text);
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
