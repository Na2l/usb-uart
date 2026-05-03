import * as path from 'path';
import * as vscode from 'vscode';
import { PortProvider, PortItem } from './portProvider';
import { UartManager } from './uartManager';
import { UartTerminal } from './uartTerminal';
import { PortSettings, DEFAULT_SETTINGS } from './portSettings';
import { PortSettingsPanel } from './portSettingsPanel';
import { MicroPythonUploader } from './micropythonUploader';

export let log: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    log = vscode.window.createOutputChannel('Serial Terminal');
    context.subscriptions.push(log);
    const version = context.extension.packageJSON.version as string;
    log.appendLine(`[Serial Terminal] v${version} activating`);

    const uart = new UartManager();
    const provider = new PortProvider();

    provider.isConnected = (p) => uart.isConnected(p);
    provider.getBaudRate = (p) => uart.getBaudRate(p);
    provider.getAlias    = (p) => getSettings(p).alias ?? '';

    const treeView = vscode.window.createTreeView('usbLocalPorts', {
        treeDataProvider: provider,
        showCollapseAll: false
    });

    // Per-port terminal state
    const terminals = new Map<string, vscode.Terminal>();
    const ptys      = new Map<string, UartTerminal>();
    const portSettings = new Map<string, PortSettings>(); // in-memory cache

    function portKey(path: string): string {
        return `portSettings:${path}`;
    }

    function getSettings(path: string): PortSettings {
        if (portSettings.has(path)) { return portSettings.get(path)!; }
        const saved = context.globalState.get<PortSettings>(portKey(path));
        const s = saved ?? DEFAULT_SETTINGS;
        portSettings.set(path, s);
        return s;
    }

    async function saveSettings(path: string, settings: PortSettings): Promise<void> {
        portSettings.set(path, settings);
        await context.globalState.update(portKey(path), settings);
    }

    async function refreshAll(): Promise<void> {
        await provider.refresh();
    }

    function openPortTerminal(item: PortItem): void {
        const existing = terminals.get(item.portPath);
        if (existing && !existing.exitStatus) {
            existing.show();
            return;
        }

        const settings = getSettings(item.portPath);
        const alias = settings.alias?.trim() || '';
        const terminalName = alias || item.portPath;
        const label = alias
            ? `${alias} (${item.portPath}) · ${uart.getBaudRate(item.portPath)} baud`
            : `${item.portPath} · ${uart.getBaudRate(item.portPath)} baud`;
        const pty = new UartTerminal(uart, item.portPath, label);
        pty.lineEnding = settings.lineEnding;
        pty.terminalMode = settings.terminalMode ?? 'uart';
        ptys.set(item.portPath, pty);

        const terminal = vscode.window.createTerminal({ name: terminalName, pty });
        terminals.set(item.portPath, terminal);
        terminal.show();

        context.subscriptions.push(
            vscode.window.onDidCloseTerminal(t => {
                if (t === terminal) {
                    terminals.delete(item.portPath);
                    ptys.delete(item.portPath);
                }
            })
        );
    }

    // Refresh tree when any port connects or disconnects
    uart.onConnectionChanged(() => provider.fire(), undefined, context.subscriptions);

    context.subscriptions.push(
        vscode.commands.registerCommand('usb-local.refresh', () => refreshAll()),

        vscode.commands.registerCommand('usb-local.connectPort', async (item?: PortItem) => {
            if (!item) { return; }
            const settings = getSettings(item.portPath);
            try {
                await uart.connect(item.portPath, settings);
            } catch (e) {
                vscode.window.showErrorMessage(`Serial Terminal: Failed to connect to ${item.portPath}: ${e}`);
                return;
            }
            const existing = terminals.get(item.portPath);
            if (existing && !existing.exitStatus) {
                existing.show();
            } else {
                openPortTerminal(item);
            }
        }),

        vscode.commands.registerCommand('usb-local.disconnectPort', async (item?: PortItem) => {
            if (!item) { return; }
            await uart.disconnect(item.portPath);
        }),

        vscode.commands.registerCommand('usb-local.openPortTerminal', (item?: PortItem) => {
            if (!item) { return; }
            openPortTerminal(item);
        }),

        vscode.commands.registerCommand('usb-local.configurePort', (item?: PortItem) => {
            if (!item) { return; }
            const current = getSettings(item.portPath);
            PortSettingsPanel.show(item.portPath, item.portPath, current, async (newSettings) => {
                await saveSettings(item.portPath, newSettings);
                provider.fire();
                // Update line ending in the live terminal immediately
                const pty = ptys.get(item.portPath);
                if (pty) {
                    pty.lineEnding = newSettings.lineEnding;
                    pty.terminalMode = newSettings.terminalMode ?? 'uart';
                }
                // If connected, reconnect with the new hardware settings
                if (uart.isConnected(item.portPath)) {
                    await uart.disconnect(item.portPath);
                    await uart.connect(item.portPath, newSettings);
                }
            });
        }),

        vscode.commands.registerCommand('usb-local.uploadFileMpy', async (arg?: vscode.Uri | PortItem) => {
            // Invoked from port tree item: arg is PortItem — ask for a local file.
            // Invoked from explorer/editor: arg is a file Uri (or undefined) — ask for a port.
            let portPath: string | undefined;
            let uri: vscode.Uri | undefined;

            if (arg instanceof PortItem) {
                portPath = arg.portPath;
                const picked = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    openLabel: 'Upload',
                    filters: { 'Python files': ['py'], 'All files': ['*'] },
                });
                if (!picked || picked.length === 0) { return; }
                uri = picked[0];
            } else {
                uri = arg ?? vscode.window.activeTextEditor?.document.uri;
                if (!uri || uri.scheme !== 'file') {
                    vscode.window.showErrorMessage('Serial Terminal: Select a file to upload.');
                    return;
                }

                const connected = uart.connectedPorts();
                if (connected.length === 0) {
                    vscode.window.showErrorMessage(
                        'Serial Terminal: No connected port. Connect to a MicroPython device first.'
                    );
                    return;
                }

                const picked = await vscode.window.showQuickPick(
                    connected.map(p => {
                        const a = getSettings(p).alias?.trim();
                        return { label: a || p, description: a ? p : undefined, portPath: p };
                    }),
                    { placeHolder: 'Select the serial port to upload to' }
                );
                if (!picked) { return; }
                portPath = picked.portPath;
            }

            const defaultName = path.basename(uri.fsPath);
            const remotePath = await vscode.window.showInputBox({
                prompt: 'Remote path on device',
                value: defaultName,
                placeHolder: 'e.g. main.py',
            });
            if (!remotePath) { return; }

            const pty = ptys.get(portPath);
            pty?.pause();

            const portLabel = getSettings(portPath).alias?.trim() || portPath;
            const uploader = new MicroPythonUploader(uart);
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `Uploading to ${portLabel}`, cancellable: true },
                async (progress, token) => {
                    try {
                        await uploader.uploadFile(portPath, uri.fsPath, remotePath, progress, token);
                        vscode.window.showInformationMessage(
                            `Uploaded ${defaultName} → ${remotePath} on ${portLabel}`
                        );
                    } catch (e: unknown) {
                        const msg = e instanceof Error ? e.message : String(e);
                        vscode.window.showErrorMessage(`Upload failed: ${msg}`);
                        log.appendLine(`[MicroPython] Upload error: ${msg}`);
                    } finally {
                        pty?.resume();
                    }
                }
            );
        }),

        treeView,
        uart
    );

    await refreshAll();
}

export function deactivate(): void {}
