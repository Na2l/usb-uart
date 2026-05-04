import * as vscode from 'vscode';
import { SerialPort } from 'serialport';

interface PortInfo {
    path: string;
    manufacturer?: string;
    serialNumber?: string;
    vendorId?: string;
    productId?: string;
    friendlyName?: string;
}

/** Returns a stable, device-identity key when USB metadata is available,
 *  falling back to the port path for ports without VID/PID/serial. */
export function stableKey(info: PortInfo): string {
    if (info.vendorId && info.productId && info.serialNumber) {
        return `${info.vendorId}:${info.productId}:${info.serialNumber}`;
    }
    return info.path;
}

export class PortItem extends vscode.TreeItem {
    /** Stable key used for persisting settings — based on VID:PID:Serial when available. */
    readonly settingsKey: string;

    constructor(
        public readonly portPath: string,
        public readonly info: PortInfo,
        isConnected: boolean,
        baudRate?: number,
        alias?: string
    ) {
        super(alias || portPath, vscode.TreeItemCollapsibleState.None);
        this.settingsKey = stableKey(info);

        const extra = info.manufacturer || info.friendlyName || '';
        this.description = alias ? portPath : (isConnected ? `${baudRate} baud` : extra);
        if (isConnected) {
            this.description = alias ? `${portPath} · ${baudRate} baud` : `${baudRate} baud`;
        }

        const tooltipLines: string[] = [portPath];
        if (info.manufacturer)  { tooltipLines.push(`Manufacturer: ${info.manufacturer}`); }
        if (info.vendorId)      { tooltipLines.push(`VID: ${info.vendorId}`); }
        if (info.productId)     { tooltipLines.push(`PID: ${info.productId}`); }
        if (info.serialNumber)  { tooltipLines.push(`Serial: ${info.serialNumber}`); }
        this.tooltip = tooltipLines.join('\n');

        this.contextValue = isConnected ? 'portConnected' : 'port';
        this.iconPath = isConnected
            ? new vscode.ThemeIcon('vm-connect', new vscode.ThemeColor('charts.green'))
            : new vscode.ThemeIcon('debug-disconnect');
        this.command = {
            command: isConnected ? 'usb-local.openPortTerminal' : 'usb-local.connectPort',
            title: isConnected ? 'Open Terminal' : 'Connect',
            arguments: [this]
        };
    }
}

export class PortProvider implements vscode.TreeDataProvider<PortItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<PortItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private ports: PortInfo[] = [];

    isConnected: (path: string) => boolean = () => false;
    getBaudRate: (path: string) => number = () => 0;
    getAlias: (path: string) => string = () => '';

    async refresh(): Promise<void> {
        const all = await SerialPort.list();
        const showAll = vscode.workspace.getConfiguration('usb-local').get<boolean>('showAllPorts', false);
        this.ports = showAll ? all : all.filter(p => p.vendorId && p.productId);
        this._onDidChangeTreeData.fire();
    }

    fire(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: PortItem): vscode.TreeItem {
        return element;
    }

    getChildren(): PortItem[] {
        return this.ports.map(p =>
            new PortItem(p.path, p, this.isConnected(p.path), this.getBaudRate(p.path), this.getAlias(stableKey(p)))
        );
    }

    /** Returns the stable settings key for a given port path. */
    getSettingsKey(portPath: string): string {
        const info = this.ports.find(p => p.path === portPath);
        return info ? stableKey(info) : portPath;
    }
}
