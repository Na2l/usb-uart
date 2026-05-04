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
            await this.writeFileInRawRepl(portPath, fileData, remotePath, token, (uploaded) => {
                progress.report({ message: `${uploaded}/${total} bytes`, increment: (CHUNK_SIZE / total) * 100 });
            });
            log.appendLine(`[MicroPython] Upload complete: ${remotePath} (${total} bytes)`);
        } finally {
            await this.exitRawRepl(portPath).catch(e => {
                log.appendLine(`[MicroPython] Warning: failed to exit raw REPL: ${e}`);
            });
        }
    }

    async uploadFolder(
        portPath: string,
        localFolder: string,
        remoteBase: string,
        progress: vscode.Progress<{ message?: string; increment?: number }>,
        token: vscode.CancellationToken
    ): Promise<void> {
        // Normalise: ensure leading slash, strip trailing slash
        const base = ('/' + remoteBase).replace(/\/+/g, '/').replace(/\/$/, '') || '/';

        const files = this.collectFiles(localFolder);
        const total = files.length;
        log.appendLine(`[MicroPython] Uploading folder ${localFolder} → ${base} (${total} files)`);

        // Collect all unique remote paths for files, preserving structure
        const remotePaths = files.map(f => {
            const rel = path.relative(localFolder, f).replace(/\\/g, '/');
            return { local: f, remote: base + '/' + rel };
        });

        // Build ordered dir list (parents before children)
        const seen = new Set<string>();
        const dirs: string[] = [];
        for (const { remote } of remotePaths) {
            const parts = remote.split('/').filter(Boolean);
            // Every prefix up to (but not including) the filename is a directory
            for (let i = 1; i < parts.length; i++) {
                const d = '/' + parts.slice(0, i).join('/');
                if (!seen.has(d)) { seen.add(d); dirs.push(d); }
            }
        }

        await this.enterRawRepl(portPath);
        try {
            // Create directories one level at a time; ignore EEXIST (errno 17)
            for (const dir of dirs) {
                if (token.isCancellationRequested) { throw new Error('Upload cancelled by user'); }
                progress.report({ message: `mkdir ${dir}` });
                try {
                    await this.execRaw(portPath, `import os; os.mkdir(${JSON.stringify(dir)})`);
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    if (!msg.includes('[Errno 17]') && !msg.includes('EEXIST')) { throw e; }
                }
            }

            for (let i = 0; i < remotePaths.length; i++) {
                if (token.isCancellationRequested) { throw new Error('Upload cancelled by user'); }
                const { local: localFile, remote: remotePath } = remotePaths[i];
                const rel = path.relative(localFolder, localFile).replace(/\\/g, '/');
                progress.report({ message: `(${i + 1}/${total}) ${rel}`, increment: (1 / total) * 100 });
                const fileData = await fs.promises.readFile(localFile);
                await this.writeFileInRawRepl(portPath, fileData, remotePath, token);
                log.appendLine(`[MicroPython] Uploaded ${remotePath} (${fileData.length} bytes)`);
            }
        } finally {
            await this.exitRawRepl(portPath).catch(e => {
                log.appendLine(`[MicroPython] Warning: failed to exit raw REPL: ${e}`);
            });
        }
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    /** Reads a text file from the device via raw REPL.
     *  Uses hex encoding to avoid conflicts with the raw-REPL protocol markers.
     *  Calls onProgress(bytesRead, total) as data arrives. */
    async readFile(
        portPath: string,
        remotePath: string,
        onProgress?: (read: number, total: number) => void,
    ): Promise<string> {
        log.appendLine(`[MicroPython] Reading ${remotePath} from ${portPath}`);
        await this.enterRawRepl(portPath);
        try {
            // Get file size via os.stat — index 6 is the size field
            const sizeOut = await this.execRaw(portPath,
                `import os; print(os.stat(${JSON.stringify(remotePath)})[6])`
            );
            const total = parseInt(sizeOut.trim(), 10);
            if (isNaN(total)) { throw new Error(`Cannot stat ${remotePath}`); }

            let hex = '';
            let read = 0;
            await this.execRaw(portPath, `_f=open(${JSON.stringify(remotePath)},'rb')`);
            while (read < total) {
                const chunk = await this.execRaw(portPath, `print(_f.read(${CHUNK_SIZE}).hex(),end='')`);
                hex += chunk.trim();
                read = Math.min(read + CHUNK_SIZE, total);
                onProgress?.(read, total);
            }
            // Best-effort close even if some chunks failed
            await this.execRaw(portPath, `_f.close();del _f`).catch(() => {});

            log.appendLine(`[MicroPython] Read ${remotePath} (${total} bytes)`);
            return Buffer.from(hex, 'hex').toString('utf-8');
        } finally {
            await this.exitRawRepl(portPath).catch(e => {
                log.appendLine(`[MicroPython] Warning: failed to exit raw REPL: ${e}`);
            });
        }
    }

    /** Writes file data to the device while already inside a raw-REPL session. */
    private async writeFileInRawRepl(
        portPath: string,
        fileData: Buffer,
        remotePath: string,
        token: vscode.CancellationToken,
        onChunk?: (uploaded: number, total: number) => void,
    ): Promise<void> {
        const total = fileData.length;
        await this.execRaw(portPath, `f=open(${JSON.stringify(remotePath)},'wb')`);
        let uploaded = 0;
        while (uploaded < total) {
            if (token.isCancellationRequested) { throw new Error('Upload cancelled by user'); }
            const end = Math.min(uploaded + CHUNK_SIZE, total);
            const chunk = fileData.slice(uploaded, end);
            await this.execRaw(portPath, `f.write(bytes.fromhex('${chunk.toString('hex')}'))`);
            uploaded = end;
            onChunk?.(uploaded, total);
        }
        await this.execRaw(portPath, `f.close()`);
    }

    private collectFiles(dir: string): string[] {
        const results: string[] = [];
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                results.push(...this.collectFiles(full));
            } else if (entry.isFile()) {
                results.push(full);
            }
        }
        return results;
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
