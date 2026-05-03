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

export class PortItem extends vscode.TreeItem {
    constructor(
        public readonly portPath: string,
        public readonly info: PortInfo,
        isConnected: boolean,
        baudRate?: number,
        alias?: string
    ) {
        super(alias || portPath, vscode.TreeItemCollapsibleState.None);

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
        this.ports = await SerialPort.list();
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
            new PortItem(p.path, p, this.isConnected(p.path), this.getBaudRate(p.path), this.getAlias(p.path))
        );
    }
}
