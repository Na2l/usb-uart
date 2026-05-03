import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { UartManager } from './uartManager';
import { log } from './extension';

/** Number of bytes per raw-REPL write chunk. Smaller = more round-trips but
 *  less risk of overflowing the device's input buffer. */
const CHUNK_SIZE = 256;

export class MicroPythonUploader {
    constructor(private readonly uart: UartManager) {}

    async uploadFile(
        portPath: string,
        localPath: string,
        remotePath: string,
        progress: vscode.Progress<{ message?: string; increment?: number }>,
        token: vscode.CancellationToken
    ): Promise<void> {
        const fileName = path.basename(localPath);
        log.appendLine(`[MicroPython] Uploading ${fileName} → ${remotePath} on ${portPath}`);

        const fileData = await fs.promises.readFile(localPath);
        const total = fileData.length;

        await this.enterRawRepl(portPath);
        try {
            progress.report({ message: 'Opening file on device…' });
            await this.execRaw(portPath, `f=open(${JSON.stringify(remotePath)},'wb')`);

            let uploaded = 0;
            while (uploaded < total) {
                if (token.isCancellationRequested) {
                    throw new Error('Upload cancelled by user');
                }
                const end = Math.min(uploaded + CHUNK_SIZE, total);
                const chunk = fileData.slice(uploaded, end);
                const hex = chunk.toString('hex');
                await this.execRaw(portPath, `f.write(bytes.fromhex('${hex}'))`);
                uploaded = end;
                progress.report({
                    message: `${uploaded}/${total} bytes`,
                    increment: (chunk.length / total) * 100,
                });
            }

            await this.execRaw(portPath, `f.close()`);
            log.appendLine(`[MicroPython] Upload complete: ${remotePath} (${total} bytes)`);
        } finally {
            await this.exitRawRepl(portPath).catch(e => {
                log.appendLine(`[MicroPython] Warning: failed to exit raw REPL: ${e}`);
            });
        }
    }

    // ── Raw REPL protocol helpers ────────────────────────────────────────────

    /**
     * Registers a data listener and resolves once `seq` is seen in the
     * accumulated incoming bytes.  The listener is registered BEFORE any write
     * so there is no race between sending a command and receiving its reply.
     */
    private waitForSeq(portPath: string, seq: Buffer, timeoutMs: number): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            let accumulated = Buffer.alloc(0);
            let timer: ReturnType<typeof setTimeout> | undefined;

            const disposable = this.uart.onData(portPath)((data: Uint8Array) => {
                accumulated = Buffer.concat([accumulated, Buffer.from(data)]);
                if (accumulated.indexOf(seq) !== -1) {
                    clearTimeout(timer);
                    disposable.dispose();
                    resolve(accumulated);
                }
            });

            timer = setTimeout(() => {
                disposable.dispose();
                reject(new Error(
                    `MicroPython: timeout waiting for ${JSON.stringify(seq.toString())}`
                ));
            }, timeoutMs);
        });
    }

    private async enterRawRepl(portPath: string): Promise<void> {
        // Interrupt any running script (twice, as recommended by mpremote)
        await this.uart.write(portPath, '\x03');
        await delay(100);
        await this.uart.write(portPath, '\x03');
        await delay(100);
        // Ctrl+A enters raw REPL mode.
        // Wait for the FULL banner including the trailing ">" prompt so it
        // doesn't leak into the first execRaw response buffer.
        const wait = this.waitForSeq(portPath, Buffer.from('CTRL-B to exit\r\n>'), 3000);
        await this.uart.write(portPath, '\x01');
        await wait;
        log.appendLine('[MicroPython] Raw REPL entered');
    }

    /** Send one Python statement and wait for its response. Returns stdout. */
    private async execRaw(portPath: string, code: string): Promise<string> {
        // Register listener BEFORE writing to eliminate any race condition.
        // Response format: OK<stdout>\x04<stderr>\x04>
        const wait = this.waitForSeq(portPath, Buffer.from('\x04>'), 8000);
        await this.uart.write(portPath, code + '\x04');
        const resp = await wait;

        const respStr = resp.toString('latin1');
        // Find 'OK' within the response — there may be residual leading bytes
        // (e.g. a stray '>' prompt) before the actual reply.
        const okIdx = respStr.indexOf('OK');
        if (okIdx === -1) {
            throw new Error(
                `MicroPython: unexpected raw REPL response: ${respStr.slice(0, 80)}`
            );
        }

        // Parse  OK<stdout>\x04<stderr>\x04>
        const afterOK  = respStr.slice(okIdx + 2);
        const eof1     = afterOK.indexOf('\x04');
        const stdout   = eof1 >= 0 ? afterOK.slice(0, eof1) : afterOK;
        const afterEof = eof1 >= 0 ? afterOK.slice(eof1 + 1) : '';
        const eof2     = afterEof.indexOf('\x04');
        const stderr   = (eof2 >= 0 ? afterEof.slice(0, eof2) : afterEof).trim();

        if (stderr.length > 0) {
            throw new Error(`MicroPython error: ${stderr}`);
        }
        return stdout;
    }

    private async exitRawRepl(portPath: string): Promise<void> {
        // Ctrl+B returns to normal REPL mode
        await this.uart.write(portPath, '\x02');
        log.appendLine('[MicroPython] Raw REPL exited');
    }
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
