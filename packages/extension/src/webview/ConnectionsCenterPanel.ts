import * as vscode from "vscode";
import type { GatewayClient } from "../gateway/GatewayClient.js";
import type { HealthMonitor } from "../health/HealthMonitor.js";
import type { ConnectionManager } from "../connections/ConnectionManager.js";
import { CONNECTION_REGISTRY } from "../connections/ConnectionRegistry.js";
import type { SimulationMode } from "@mcp-proxy/shared";

type WebviewMessage =
  | { type: "ready" }
  | { type: "restart"; connectionId: string }
  | { type: "simulate"; connectionId: string; mode: SimulationMode }
  | { type: "copyDiagnostics"; connectionId: string }
  | { type: "signIn"; connectionId: string }
  | { type: "openSettings"; connectionId: string };

export class ConnectionsCenterPanel {
  static current: ConnectionsCenterPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static createOrShow(
    context: vscode.ExtensionContext,
    gatewayClient: GatewayClient,
    healthMonitor: HealthMonitor,
    connectionManager: ConnectionManager
  ): ConnectionsCenterPanel {
    if (ConnectionsCenterPanel.current) {
      ConnectionsCenterPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return ConnectionsCenterPanel.current;
    }

    const panel = vscode.window.createWebviewPanel(
      "managedConnections.center",
      "Connections Center",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [context.extensionUri],
      }
    );

    const instance = new ConnectionsCenterPanel(
      panel, context, gatewayClient, healthMonitor, connectionManager
    );
    ConnectionsCenterPanel.current = instance;
    return instance;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    private readonly gatewayClient: GatewayClient,
    private readonly healthMonitor: HealthMonitor,
    private readonly connectionManager: ConnectionManager
  ) {
    this.panel = panel;
    this.panel.webview.html = buildHtml(this.panel.webview, context.extensionUri);

    this.disposables.push(
      healthMonitor.onHealthChanged(() => this.pushState())
    );

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((msg: WebviewMessage) => {
        void this.handleMessage(msg);
      })
    );

    this.panel.onDidDispose(() => {
      ConnectionsCenterPanel.current = undefined;
      this.disposables.forEach((d) => d.dispose());
    });
  }

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.pushState();
        break;

      case "restart":
        try {
          await this.gatewayClient.restart(msg.connectionId);
          this.pushState();
          this.toast(`Restarted ${msg.connectionId}`, "info");
        } catch (err) {
          this.toast(String(err), "error");
        }
        break;

      case "simulate":
        try {
          await this.gatewayClient.simulate(msg.connectionId, msg.mode);
          this.pushState();
        } catch (err) {
          this.toast(String(err), "error");
        }
        break;

      case "copyDiagnostics":
        try {
          const diag = await this.gatewayClient.getDiagnostics(msg.connectionId);
          await vscode.env.clipboard.writeText(JSON.stringify(diag, null, 2));
          this.toast("Diagnostics JSON copied to clipboard", "info");
        } catch (err) {
          this.toast(String(err), "error");
        }
        break;

      case "signIn":
        try {
          await this.connectionManager.signIn(msg.connectionId);
          this.pushState();
        } catch (err) {
          this.toast(String(err), "error");
        }
        break;

      case "openSettings":
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          `managedConnections.${msg.connectionId}`
        );
        break;
    }
  }

  private pushState(): void {
    const connections = CONNECTION_REGISTRY.map((def) => ({
      id: def.id,
      name: def.name,
      description: def.description,
      isSimulatable: def.id === "test-echo",
      requiresExplicitEnable: def.requiresExplicitEnable ?? false,
      health: this.healthMonitor.getHealth(def.id) ?? null,
    }));
    this.panel.webview.postMessage({ type: "stateUpdate", connections });
  }

  private toast(message: string, kind: "info" | "error"): void {
    this.panel.webview.postMessage({ type: "toast", message, kind });
  }
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 32; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

function buildHtml(_webview: vscode.Webview, _extensionUri: vscode.Uri): string {
  const nonce = getNonce();
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
  ].join("; ");

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Connections Center</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 24px 20px;
      max-width: 860px;
    }

    h1 {
      font-size: 1.25em;
      font-weight: 600;
      margin-bottom: 4px;
    }

    .subtitle {
      color: var(--vscode-descriptionForeground);
      font-size: 0.875em;
      margin-bottom: 20px;
    }

    /* ── Summary bar ──────────────────────────────────────────────── */
    .summary {
      display: flex;
      gap: 20px;
      padding: 10px 14px;
      background: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 6px;
      margin-bottom: 18px;
      flex-wrap: wrap;
      align-items: center;
    }

    .summary-item {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.875em;
    }

    .summary-count {
      font-weight: 700;
      font-size: 1.1em;
      min-width: 1.4em;
      text-align: center;
    }

    .summary-count.c-ready    { color: var(--vscode-testing-iconPassed, #4ec9b0); }
    .summary-count.c-warn     { color: var(--vscode-editorWarning-foreground, #cca700); }
    .summary-count.c-error    { color: var(--vscode-testing-iconFailed, #f14c4c); }
    .summary-count.c-muted    { color: var(--vscode-disabledForeground); }

    /* ── Needs-attention panel ────────────────────────────────────── */
    .attention-panel {
      border: 1px solid var(--vscode-inputValidation-warningBorder, #b89500);
      border-radius: 6px;
      padding: 12px 16px;
      margin-bottom: 20px;
      background: var(--vscode-inputValidation-warningBackground, rgba(204, 167, 0, 0.08));
    }

    .attention-panel h2 {
      font-size: 0.9em;
      font-weight: 600;
      margin-bottom: 10px;
    }

    .attention-list {
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .attention-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }

    .attention-name { font-weight: 500; font-size: 0.9em; }
    .attention-status { color: var(--vscode-descriptionForeground); font-size: 0.85em; }

    /* ── Section header ───────────────────────────────────────────── */
    .section-header {
      font-size: 0.75em;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.09em;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 10px;
    }

    /* ── Cards ────────────────────────────────────────────────────── */
    .cards { display: flex; flex-direction: column; gap: 10px; }

    .card {
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, #454545));
      border-radius: 8px;
      padding: 14px 16px;
      background: var(--vscode-editor-background);
      transition: border-color 0.15s;
    }

    .card:focus-within {
      border-color: var(--vscode-focusBorder);
    }

    .card-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 6px;
    }

    .card-title-group {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .card-icon { font-size: 1.15em; line-height: 1; flex-shrink: 0; }
    .card-name { font-weight: 600; font-size: 1em; }

    /* ── Status badge ─────────────────────────────────────────────── */
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 2px 9px;
      border-radius: 12px;
      font-size: 0.78em;
      font-weight: 500;
      white-space: nowrap;
      flex-shrink: 0;
    }

    .status-dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    /* ready */
    .s-ready .status-dot { background: var(--vscode-testing-iconPassed, #4ec9b0); }
    .s-ready { background: rgba(78, 201, 176, 0.13); color: var(--vscode-testing-iconPassed, #4ec9b0); }

    /* starting / stopping */
    .s-starting .status-dot, .s-stopping .status-dot { background: var(--vscode-progressBar-background, #0e70c0); }
    .s-starting, .s-stopping { background: rgba(14, 112, 192, 0.13); color: var(--vscode-progressBar-background, #0e70c0); }

    /* crashed */
    .s-crashed .status-dot { background: var(--vscode-testing-iconFailed, #f14c4c); }
    .s-crashed { background: rgba(241, 76, 76, 0.13); color: var(--vscode-testing-iconFailed, #f14c4c); }

    /* degraded / auth_required / dependency_missing / version_mismatch */
    .s-degraded .status-dot,
    .s-auth_required .status-dot,
    .s-dependency_missing .status-dot,
    .s-version_mismatch .status-dot { background: var(--vscode-editorWarning-foreground, #cca700); }
    .s-degraded,
    .s-auth_required,
    .s-dependency_missing,
    .s-version_mismatch { background: rgba(204, 167, 0, 0.13); color: var(--vscode-editorWarning-foreground, #cca700); }

    /* not_configured / unsafe_disabled / blocked_by_policy */
    .s-not_configured .status-dot,
    .s-unsafe_disabled .status-dot,
    .s-blocked_by_policy .status-dot { background: var(--vscode-disabledForeground, #888); }
    .s-not_configured,
    .s-unsafe_disabled,
    .s-blocked_by_policy { background: rgba(136, 136, 136, 0.13); color: var(--vscode-disabledForeground, #888); }

    /* ── Card body ────────────────────────────────────────────────── */
    .card-description {
      color: var(--vscode-descriptionForeground);
      font-size: 0.875em;
      line-height: 1.5;
      margin-bottom: 10px;
    }

    .card-meta {
      font-size: 0.82em;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 10px;
    }

    /* ── Actions ──────────────────────────────────────────────────── */
    .card-actions { display: flex; gap: 7px; flex-wrap: wrap; margin-bottom: 8px; }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 11px;
      border-radius: 4px;
      border: 1px solid transparent;
      font-family: var(--vscode-font-family);
      font-size: 0.82em;
      cursor: pointer;
      white-space: nowrap;
    }

    .btn:focus-visible {
      outline: 2px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }

    .btn-primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: var(--vscode-button-background);
    }
    .btn-primary:hover { background: var(--vscode-button-hoverBackground); }

    .btn-secondary {
      background: var(--vscode-button-secondaryBackground, transparent);
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      border-color: var(--vscode-widget-border, #454545);
    }
    .btn-secondary:hover { background: var(--vscode-list-hoverBackground); }

    /* ── Diagnostics expander ─────────────────────────────────────── */
    .diag-bar {
      border-top: 1px solid var(--vscode-widget-border, #454545);
      padding-top: 8px;
      margin-top: 4px;
    }

    .diag-toggle {
      background: none;
      border: none;
      cursor: pointer;
      color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-font-family);
      font-size: 0.8em;
      padding: 2px 0;
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .diag-toggle:hover { color: var(--vscode-foreground); }
    .diag-toggle:focus-visible {
      outline: 2px solid var(--vscode-focusBorder);
      outline-offset: 2px;
      border-radius: 2px;
    }

    .diag-chevron { font-size: 0.75em; transition: transform 0.15s; }
    .diag-toggle[aria-expanded="true"] .diag-chevron { transform: rotate(90deg); }

    .diag-content { display: none; margin-top: 10px; }
    .diag-content.open { display: block; }

    .diag-section { margin-bottom: 10px; }

    .diag-label {
      font-size: 0.75em;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 3px;
    }

    .diag-value {
      font-size: 0.82em;
      font-family: var(--vscode-editor-font-family, monospace);
      background: var(--vscode-textCodeBlock-background, var(--vscode-editor-inactiveSelectionBackground));
      padding: 6px 9px;
      border-radius: 4px;
      white-space: pre-wrap;
      word-break: break-word;
    }

    /* ── Simulate grid ────────────────────────────────────────────── */
    .simulate-grid {
      display: flex;
      gap: 5px;
      flex-wrap: wrap;
      margin-top: 6px;
    }

    /* ── Toast ────────────────────────────────────────────────────── */
    #toasts {
      position: fixed;
      bottom: 16px;
      right: 16px;
      display: flex;
      flex-direction: column-reverse;
      gap: 8px;
      z-index: 999;
      pointer-events: none;
    }

    .toast {
      padding: 9px 14px;
      border-radius: 5px;
      font-size: 0.875em;
      max-width: 320px;
      pointer-events: auto;
      animation: slideUp 0.2s ease;
    }

    .toast-info  { background: var(--vscode-notificationsInfoIcon-foreground, #0e70c0); color: #fff; }
    .toast-error { background: var(--vscode-notificationsErrorIcon-foreground, #f14c4c); color: #fff; }

    @keyframes slideUp {
      from { opacity: 0; transform: translateY(6px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    /* ── Loading ──────────────────────────────────────────────────── */
    .loading {
      color: var(--vscode-descriptionForeground);
      padding: 40px 0;
      text-align: center;
      font-size: 0.9em;
    }
  </style>
</head>
<body>
  <h1>Connections</h1>
  <p class="subtitle">GitHub Copilot tool connections managed by this extension</p>

  <div id="root">
    <div class="loading" aria-live="polite">Loading connections&hellip;</div>
  </div>

  <div id="toasts" aria-live="polite" aria-atomic="false"></div>

  <script nonce="${nonce}">
  (function () {
    'use strict';

    const vscode = acquireVsCodeApi();
    let connections = [];

    /* ── Static maps ──────────────────────────────────────────────── */
    const STATUS_LABEL = {
      ready:              'Ready',
      starting:           'Starting',
      stopping:           'Stopping',
      crashed:            'Crashed',
      degraded:           'Degraded',
      auth_required:      'Sign in required',
      dependency_missing: 'Missing tools',
      not_configured:     'Not set up',
      unsafe_disabled:    'Disabled',
      blocked_by_policy:  'Blocked by policy',
      version_mismatch:   'Version mismatch',
    };

    const CONNECTION_ICON = {
      'test-echo':       '⚗',
      'local-knowledge': '📖',
      'github':          '⬡',
      'atlassian':       '☷',
      'playwright':      '🌐',
    };

    const SIMULATION_MODES = [
      'ready', 'slow_start', 'crash_on_start', 'crash_after_delay',
      'hang', 'bad_json', 'auth_required', 'dependency_missing',
      'version_mismatch', 'unsafe_tools', 'crash_during_tool_call',
    ];

    /* ── Helpers ──────────────────────────────────────────────────── */
    function needsAttention(status) {
      return ['crashed', 'degraded', 'auth_required', 'dependency_missing', 'version_mismatch'].includes(status);
    }

    function isReady(status) { return status === 'ready'; }

    function isDisabledLike(status) {
      return ['not_configured', 'unsafe_disabled', 'blocked_by_policy'].includes(status);
    }

    function esc(v) {
      return String(v ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function send(msg) { vscode.postMessage(msg); }

    /* ── Message bus ──────────────────────────────────────────────── */
    window.addEventListener('message', function (event) {
      const msg = event.data;
      if (msg.type === 'stateUpdate') {
        connections = msg.connections || [];
        render();
      } else if (msg.type === 'toast') {
        showToast(msg.message, msg.kind || 'info');
      }
    });

    send({ type: 'ready' });

    /* ── Render ───────────────────────────────────────────────────── */
    function render() {
      const readyCount   = connections.filter(c => isReady(c.health?.status)).length;
      const attentionAll = connections.filter(c => c.health && needsAttention(c.health.status));
      const disabledCount = connections.filter(c => !c.health || isDisabledLike(c.health?.status)).length;

      let html = '';

      /* Summary bar */
      html += '<div class="summary" role="status" aria-label="Connections summary">';
      html += '<div class="summary-item"><span class="summary-count c-ready">' + readyCount + '</span><span>ready</span></div>';
      if (attentionAll.length > 0) {
        html += '<div class="summary-item"><span class="summary-count c-warn">' + attentionAll.length + '</span><span>need' + (attentionAll.length === 1 ? 's' : '') + ' attention</span></div>';
      }
      if (disabledCount > 0) {
        html += '<div class="summary-item"><span class="summary-count c-muted">' + disabledCount + '</span><span>disabled / not set up</span></div>';
      }
      html += '</div>';

      /* Attention panel */
      if (attentionAll.length > 0) {
        html += '<div class="attention-panel" role="region" aria-label="Connections needing attention">';
        html += '<h2>&#9888; Needs attention</h2>';
        html += '<ul class="attention-list">';
        for (const c of attentionAll) {
          const status = c.health?.status ?? 'not_configured';
          html += '<li class="attention-item">';
          html += '<div><span class="attention-name">' + esc(c.name) + '</span>';
          html += '<span class="attention-status"> &mdash; ' + esc(STATUS_LABEL[status] || status) + '</span></div>';
          html += '<div>' + primaryBtn(c) + '</div>';
          html += '</li>';
        }
        html += '</ul></div>';
      }

      /* Cards section */
      html += '<div class="section-header">All connections</div>';
      html += '<div class="cards" role="list">';
      for (const c of connections) {
        html += renderCard(c);
      }
      html += '</div>';

      document.getElementById('root').innerHTML = html;
      attachListeners();
    }

    /* ── Card HTML ────────────────────────────────────────────────── */
    function renderCard(conn) {
      const h      = conn.health;
      const status = h?.status ?? 'not_configured';
      const label  = STATUS_LABEL[status] || status;
      const icon   = CONNECTION_ICON[conn.id] || '⬡';
      const tools  = h?.toolCount ?? 0;
      const hidden = h?.hiddenToolCount ?? 0;

      let out = '';
      out += '<div class="card" role="listitem" id="card-' + esc(conn.id) + '">';

      /* Header row */
      out += '<div class="card-header">';
      out += '<div class="card-title-group">';
      out += '<span class="card-icon" aria-hidden="true">' + icon + '</span>';
      out += '<span class="card-name">' + esc(conn.name) + '</span>';
      out += '</div>';
      out += '<span class="status-badge s-' + esc(status) + '" role="status" aria-label="Status: ' + esc(label) + '">';
      out += '<span class="status-dot" aria-hidden="true"></span>' + esc(label);
      out += '</span>';
      out += '</div>';

      /* Description */
      out += '<p class="card-description">' + esc(conn.description) + '</p>';

      /* Tool count meta (only when ready) */
      if (status === 'ready') {
        let meta = tools + ' tool' + (tools !== 1 ? 's' : '') + ' available';
        if (hidden > 0) meta += ' &bull; ' + hidden + ' hidden by safety policy';
        out += '<div class="card-meta">' + meta + '</div>';
      }

      /* Action buttons */
      const actions = cardActions(conn);
      if (actions.length) {
        out += '<div class="card-actions">' + actions.join('') + '</div>';
      }

      /* Diagnostics expander */
      out += '<div class="diag-bar">';
      out += '<button class="diag-toggle" data-conn="' + esc(conn.id) + '" aria-expanded="false" aria-controls="diag-' + esc(conn.id) + '">';
      out += '<span class="diag-chevron" aria-hidden="true">&#9658;</span> Advanced diagnostics';
      out += '</button>';
      out += '<div class="diag-content" id="diag-' + esc(conn.id) + '" role="region" aria-label="Diagnostics for ' + esc(conn.name) + '">';

      /* Diagnostics body */
      if (h?.assistantSummary) {
        out += diag('Summary', h.assistantSummary);
      }
      if (h?.technicalMessage) {
        out += diag('Last error', h.technicalMessage);
      }
      if (h) {
        const detail = 'Status:  ' + status +
          '\nTools:   ' + tools + (hidden ? ' (' + hidden + ' hidden)' : '') +
          '\nUptime:  ' + (h.uptimeMs != null ? Math.round(h.uptimeMs / 1000) + 's' : 'n/a') +
          '\nCrashes: ' + (h.crashCount ?? 0);
        out += diag('Details', detail);
      }

      /* Simulation controls (test-echo only) */
      if (conn.isSimulatable) {
        out += '<div class="diag-section">';
        out += '<div class="diag-label">Simulate failure mode</div>';
        out += '<div class="simulate-grid">';
        for (const mode of SIMULATION_MODES) {
          out += '<button class="btn btn-secondary" data-action="simulate" data-conn="' + esc(conn.id) + '" data-mode="' + esc(mode) + '">' + esc(mode) + '</button>';
        }
        out += '</div></div>';
      }

      /* Copy diagnostics */
      out += '<div class="diag-section">';
      out += '<button class="btn btn-secondary" data-action="copyDiagnostics" data-conn="' + esc(conn.id) + '">Copy diagnostics JSON</button>';
      out += '</div>';

      out += '</div></div>'; /* diag-content + diag-bar */
      out += '</div>';       /* card */
      return out;
    }

    function diag(label, value) {
      return '<div class="diag-section"><div class="diag-label">' + esc(label) + '</div>' +
             '<div class="diag-value">' + esc(value) + '</div></div>';
    }

    /* ── Action helpers ───────────────────────────────────────────── */
    function cardActions(conn) {
      const status = conn.health?.status ?? 'not_configured';
      switch (status) {
        case 'ready':
          return [mkBtn('secondary', 'restart', conn.id, null, '&#8635; Restart')];
        case 'crashed':
          return [
            mkBtn('primary',    'restart',         conn.id, null, '&#8635; Restart'),
            mkBtn('secondary',  'copyDiagnostics',  conn.id, null, 'Copy diagnostics'),
          ];
        case 'degraded':
          return [
            mkBtn('secondary', 'restart',        conn.id, null, '&#8635; Restart'),
            mkBtn('secondary', 'copyDiagnostics', conn.id, null, 'Copy diagnostics'),
          ];
        case 'auth_required':
          return [mkBtn('primary', 'signIn', conn.id, null, '&#128273; Sign In')];
        case 'dependency_missing':
          return [mkBtn('primary', 'openSettings', conn.id, null, '&#8659; Install Tools')];
        case 'version_mismatch':
          return [mkBtn('secondary', 'openSettings', conn.id, null, 'Open Settings')];
        case 'not_configured':
          return [mkBtn('secondary', 'openSettings', conn.id, null, 'Configure')];
        case 'unsafe_disabled':
          return [mkBtn('secondary', 'openSettings', conn.id, null, 'Enable in Settings')];
        default:
          return [];
      }
    }

    function primaryBtn(conn) {
      const status = conn.health?.status ?? 'not_configured';
      switch (status) {
        case 'crashed':            return mkBtn('primary',   'restart',      conn.id, null, '&#8635; Restart');
        case 'auth_required':      return mkBtn('primary',   'signIn',       conn.id, null, '&#128273; Sign In');
        case 'dependency_missing': return mkBtn('primary',   'openSettings', conn.id, null, '&#8659; Install');
        case 'degraded':           return mkBtn('secondary', 'restart',      conn.id, null, '&#8635; Restart');
        case 'version_mismatch':   return mkBtn('secondary', 'openSettings', conn.id, null, 'Settings');
        default:                   return '';
      }
    }

    function mkBtn(style, action, connId, mode, label) {
      const modeAttr = mode ? ' data-mode="' + esc(mode) + '"' : '';
      return '<button class="btn btn-' + style + '" data-action="' + esc(action) + '" data-conn="' + esc(connId) + '"' + modeAttr + ' aria-label="' + esc(label.replace(/&#[0-9]+;/g, '')) + ' ' + esc(connId) + '">' + label + '</button>';
    }

    /* ── Event delegation ─────────────────────────────────────────── */
    function attachListeners() {
      document.querySelectorAll('[data-action]').forEach(function (el) {
        el.addEventListener('click', onAction);
      });
      document.querySelectorAll('.diag-toggle').forEach(function (el) {
        el.addEventListener('click', onToggleDiag);
      });
    }

    function onAction(e) {
      const el     = e.currentTarget;
      const action = el.dataset.action;
      const connId = el.dataset.conn;
      const mode   = el.dataset.mode;

      switch (action) {
        case 'restart':          send({ type: 'restart',         connectionId: connId }); break;
        case 'simulate':         send({ type: 'simulate',        connectionId: connId, mode: mode }); break;
        case 'copyDiagnostics':  send({ type: 'copyDiagnostics', connectionId: connId }); break;
        case 'signIn':           send({ type: 'signIn',          connectionId: connId }); break;
        case 'openSettings':     send({ type: 'openSettings',    connectionId: connId }); break;
      }
    }

    function onToggleDiag(e) {
      const btn    = e.currentTarget;
      const connId = btn.dataset.conn;
      const content = document.getElementById('diag-' + connId);
      if (!content) return;
      const opening = !content.classList.contains('open');
      content.classList.toggle('open', opening);
      btn.setAttribute('aria-expanded', String(opening));
    }

    /* ── Toast ────────────────────────────────────────────────────── */
    function showToast(message, kind) {
      const container = document.getElementById('toasts');
      const el = document.createElement('div');
      el.className = 'toast toast-' + kind;
      el.setAttribute('role', 'alert');
      el.textContent = message;
      container.appendChild(el);
      setTimeout(function () { el.remove(); }, 4000);
    }
  })();
  </script>
</body>
</html>`;
}
