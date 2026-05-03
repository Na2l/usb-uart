export interface PortSettings {
    baudRate: number;
    dataBits: 7 | 8;
    stopBits: 1 | 2;
    parity: 'none' | 'even' | 'odd';
    flowControl: 'none' | 'hardware';
    lineEnding: 'cr' | 'lf' | 'crlf';
    terminalMode: 'uart' | 'micropython';
    alias: string;
}

export const DEFAULT_SETTINGS: PortSettings = {
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    flowControl: 'none',
    lineEnding: 'cr',
    terminalMode: 'uart',
    alias: '',
};
