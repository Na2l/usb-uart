import * as vscode from 'vscode';
import { PortSettings } from './portSettings';

export class PortSettingsPanel {
    private static readonly panels = new Map<string, PortSettingsPanel>();

    private readonly panel: vscode.WebviewPanel;

    static show(
        portPath: string,
        portLabel: string,
        settings: PortSettings,
        onApply: (settings: PortSettings) => Promise<void>
    ): void {
        const existing = PortSettingsPanel.panels.get(portPath);
        if (existing) {
            existing.panel.reveal(vscode.ViewColumn.One);
            existing.panel.webview.postMessage({ type: 'update', settings });
            return;
        }
        new PortSettingsPanel(portPath, portLabel, settings, onApply);
    }

    private constructor(
        portPath: string,
        portLabel: string,
        settings: PortSettings,
        onApply: (settings: PortSettings) => Promise<void>
    ) {
        this.panel = vscode.window.createWebviewPanel(
            'portSettings',
            `Settings — ${portLabel}`,
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        this.panel.webview.html = PortSettingsPanel.buildHtml(settings);

        this.panel.webview.onDidReceiveMessage(async (msg: { type: string; settings: PortSettings }) => {
            if (msg.type === 'apply') {
                await onApply(msg.settings);
                this.panel.webview.postMessage({ type: 'applied' });
            }
        });

        this.panel.onDidDispose(() => PortSettingsPanel.panels.delete(portPath));
        PortSettingsPanel.panels.set(portPath, this);
    }

    private static buildHtml(settings: PortSettings): string {
        const init = JSON.stringify(settings);
        return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 24px;
    max-width: 440px;
    margin: 0;
  }
  h2 {
    margin-top: 0;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .section {
    font-size: 0.82em;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--vscode-descriptionForeground);
    margin: 22px 0 10px;
  }
  .field { margin-bottom: 12px; }
  label { display: block; margin-bottom: 3px; }
  select {
    width: 100%;
    padding: 4px 6px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 2px;
    font-family: inherit;
    font-size: inherit;
    box-sizing: border-box;
  }
  .actions { margin-top: 24px; display: flex; align-items: center; gap: 12px; }
  button {
    padding: 5px 16px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 2px;
    cursor: pointer;
    font-family: inherit;
    font-size: inherit;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  #status { font-size: 0.9em; color: var(--vscode-charts-green, #4caf50); }
  input[type="text"] {
    width: 100%;
    padding: 4px 6px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 2px;
    font-family: inherit;
    font-size: inherit;
    box-sizing: border-box;
  }
</style>
</head>
<body>
<h2>Port Settings</h2>

<div class="section">General</div>

<div class="field">
  <label for="alias">Friendly Name</label>
  <input type="text" id="alias" placeholder="e.g. ESP32 sensor" />
</div>

<div class="section">Connection</div>

<div class="field">
  <label for="baudRate">Baud Rate</label>
  <select id="baudRate">
    <option value="9600">9600</option>
    <option value="19200">19200</option>
    <option value="38400">38400</option>
    <option value="57600">57600</option>
    <option value="115200">115200</option>
    <option value="230400">230400</option>
    <option value="921600">921600</option>
  </select>
</div>

<div class="field">
  <label for="dataBits">Data Bits</label>
  <select id="dataBits">
    <option value="8">8</option>
    <option value="7">7</option>
  </select>
</div>

<div class="field">
  <label for="stopBits">Stop Bits</label>
  <select id="stopBits">
    <option value="1">1</option>
    <option value="2">2</option>
  </select>
</div>

<div class="field">
  <label for="parity">Parity</label>
  <select id="parity">
    <option value="none">None</option>
    <option value="even">Even</option>
    <option value="odd">Odd</option>
  </select>
</div>

<div class="field">
  <label for="flowControl">Flow Control</label>
  <select id="flowControl">
    <option value="none">None</option>
    <option value="hardware">Hardware (RTS/CTS)</option>
  </select>
</div>

<div class="section">Terminal</div>

<div class="field">
  <label for="lineEnding">Line Ending (sent on Enter)</label>
  <select id="lineEnding">
    <option value="cr">CR (\\r) — most serial consoles</option>
    <option value="lf">LF (\\n)</option>
    <option value="crlf">CR+LF (\\r\\n)</option>
  </select>
</div>
<div class="field">
  <label for="terminalMode">Terminal Mode</label>
  <select id="terminalMode">
    <option value="uart">UART — line-buffered input</option>
    <option value="micropython">MicroPython — pass-through input</option>
  </select>
</div>
<div class="actions">
  <button onclick="apply()">Apply</button>
  <span id="status"></span>
</div>

<script>
  const vscode = acquireVsCodeApi();

  function populate(s) {
    document.getElementById('alias').value        = s.alias ?? '';
    document.getElementById('baudRate').value     = String(s.baudRate);
    document.getElementById('dataBits').value     = String(s.dataBits);
    document.getElementById('stopBits').value     = String(s.stopBits);
    document.getElementById('parity').value       = s.parity;
    document.getElementById('flowControl').value  = s.flowControl;
    document.getElementById('lineEnding').value   = s.lineEnding;
    document.getElementById('terminalMode').value = s.terminalMode ?? 'uart';
  }

  function apply() {
    const s = {
      alias:        document.getElementById('alias').value.trim(),
      baudRate:     parseInt(document.getElementById('baudRate').value, 10),
      dataBits:     parseInt(document.getElementById('dataBits').value, 10),
      stopBits:     parseInt(document.getElementById('stopBits').value, 10),
      parity:       document.getElementById('parity').value,
      flowControl:  document.getElementById('flowControl').value,
      lineEnding:   document.getElementById('lineEnding').value,
      terminalMode: document.getElementById('terminalMode').value
    };
    document.getElementById('status').textContent = '';
    vscode.postMessage({ type: 'apply', settings: s });
  }

  window.addEventListener('message', e => {
    if (e.data.type === 'update')  { populate(e.data.settings); }
    if (e.data.type === 'applied') {
      document.getElementById('status').textContent = 'Applied ✓';
      setTimeout(() => { document.getElementById('status').textContent = ''; }, 2000);
    }
  });

  populate(${init});
</script>
</body>
</html>`;
    }
}
