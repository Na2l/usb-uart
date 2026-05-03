import * as vscode from 'vscode';
import { SerialPort } from 'serialport';
import { log } from './extension';
import { PortSettings } from './portSettings';

interface PortSession {
    settings: PortSettings;
    port: SerialPort;
    onData: vscode.EventEmitter<Uint8Array>;
}

export class UartManager implements vscode.Disposable {
    private sessions = new Map<string, PortSession>();

    private _onConnectionChanged = new vscode.EventEmitter<string>();
    /** Fires with the path of the port that connected or disconnected. */
    readonly onConnectionChanged = this._onConnectionChanged.event;

    isConnected(path: string): boolean {
        return this.sessions.has(path);
    }

    getBaudRate(path: string): number {
        return this.sessions.get(path)?.settings.baudRate ?? 0;
    }

    /** Returns the per-port data event, or a no-op event if not connected. */
    onData(path: string): vscode.Event<Uint8Array> {
        const session = this.sessions.get(path);
        return session ? session.onData.event : (_listener: any) => ({ dispose: () => {} });
    }

    async connect(path: string, settings: PortSettings): Promise<void> {
        if (this.sessions.has(path)) { return; }

        const port = new SerialPort({
            path,
            baudRate: settings.baudRate,
            dataBits: settings.dataBits,
            stopBits: settings.stopBits,
            parity:   settings.parity,
            rtscts:   settings.flowControl === 'hardware',
            autoOpen: false,
        });

        await new Promise<void>((resolve, reject) => {
            port.open(err => err ? reject(err) : resolve());
        });

        const onData = new vscode.EventEmitter<Uint8Array>();

        port.on('data', (data: Buffer) => {
            onData.fire(data);
            log.appendLine(`[Serial] ← ${data.length} byte(s)`);
        });

        // Handle unexpected close (e.g. device unplugged).
        // We remove the session first in disconnect() so this handler only
        // fires for unintentional closes.
        port.on('close', () => {
            const session = this.sessions.get(path);
            if (session) {
                session.onData.dispose();
                this.sessions.delete(path);
                this._onConnectionChanged.fire(path);
                log.appendLine('[Serial] Port closed unexpectedly');
            }
        });

        port.on('error', (err: Error) => {
            log.appendLine(`[Serial] Error on ${path}: ${err.message}`);
        });

        this.sessions.set(path, { settings, port, onData });
        this._onConnectionChanged.fire(path);
        log.appendLine(`[Serial] Connected to ${path} at ${settings.baudRate} baud`);
    }

    async disconnect(path: string): Promise<void> {
        const session = this.sessions.get(path);
        if (!session) { return; }

        // Remove before closing so the 'close' event handler treats this as intentional.
        this.sessions.delete(path);

        await new Promise<void>((resolve) => {
            session.port.close(() => resolve());
        });

        session.onData.dispose();
        this._onConnectionChanged.fire(path);
        log.appendLine(`[Serial] Disconnected from ${path}`);
    }

    async write(path: string, data: string | Uint8Array): Promise<void> {
        const session = this.sessions.get(path);
        if (!session) { throw new Error('Port not connected'); }
        const bytes = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data);
        await new Promise<void>((resolve, reject) => {
            session.port.write(bytes, err => err ? reject(err) : resolve());
        });
        log.appendLine(`[Serial] → ${bytes.length} byte(s)`);
    }

    connectedPorts(): string[] {
        return [...this.sessions.keys()];
    }

    dispose(): void {
        for (const [path] of this.sessions) {
            this.disconnect(path).catch(() => {});
        }
        this._onConnectionChanged.dispose();
    }
}
