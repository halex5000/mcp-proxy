import * as vscode from "vscode";
import type { GatewayClient } from "../gateway/GatewayClient.js";
import type { HealthMonitor } from "../health/HealthMonitor.js";
import type { ConnectionManager } from "../connections/ConnectionManager.js";
import { CONNECTION_REGISTRY } from "../connections/ConnectionRegistry.js";
import type { ConnectionDefinition, ConnectionHealth, SimulationMode } from "@mcp-proxy/shared";

/**
 * ConnectionsCenterPanel renders the product-facing "Connections Center": a
 * full editor-area webview that presents MCP connections as friendly capability
 * cards rather than raw servers.
 *
 * Architecture boundary (do not cross): the webview owns UI only. It never talks
 * to the gateway directly. Every action travels:
 *
 *   webview --postMessage--> ConnectionsCenterPanel --> GatewayClient/commands
 *                                                    --> gateway /control/*
 *
 * The extension mediates because it owns the gateway bearer token, the port, and
 * VS Code integration (auth sessions, settings, diagnostics panel).
 */
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
      panel, gatewayClient, healthMonitor, connectionManager
    );
    ConnectionsCenterPanel.current = instance;
    return instance;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly gatewayClient: GatewayClient,
    private readonly healthMonitor: HealthMonitor,
    private readonly connectionManager: ConnectionManager
  ) {
    this.panel = panel;
    this.panel.webview.html = buildHtml();

    this.disposables.push(
      this.healthMonitor.onHealthChanged(() => {
        void this.refresh();
      })
    );

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((msg: InboundMessage) => {
        void this.handleMessage(msg);
      })
    );

    this.panel.onDidDispose(() => {
      ConnectionsCenterPanel.current = undefined;
      this.disposables.forEach((d) => d.dispose());
    });
  }

  // ── Message bridge ──────────────────────────────────────────────────────────

  private async handleMessage(msg: InboundMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
      case "refresh":
        await this.refresh();
        break;

      case "verifySetup":
        await vscode.commands.executeCommand("managedConnections.verifyLocalSetup");
        await this.refresh();
        break;

      case "restart":
        await this.run(`Restarting ${msg.connectionId}…`, async () => {
          await this.gatewayClient.restart(msg.connectionId);
        }, `Restarted ${this.nameOf(msg.connectionId)}.`);
        break;

      case "simulate":
        await this.run(`Simulating ${msg.mode}…`, async () => {
          await this.gatewayClient.simulate(msg.connectionId, msg.mode);
        });
        break;

      case "signIn":
        await this.run(undefined, async () => {
          await vscode.commands.executeCommand("managedConnections.signIn", {
            connectionId: msg.connectionId,
          });
        });
        break;

      case "setup":
        await this.handleSetup(msg.connectionId);
        break;

      case "enableSafeMode":
        await this.run(undefined, async () => {
          await vscode.commands.executeCommand("managedConnections.enableConnection", {
            connectionId: msg.connectionId,
          });
        });
        break;

      case "openDiagnostics":
        await vscode.commands.executeCommand("managedConnections.openDiagnostics", {
          connectionId: msg.connectionId,
          label: this.nameOf(msg.connectionId),
        });
        break;

      case "copyDiagnostics":
        try {
          const diag = await this.gatewayClient.getDiagnostics(msg.connectionId);
          await vscode.env.clipboard.writeText(JSON.stringify(diag, null, 2));
          this.toast(`Copied diagnostics for ${this.nameOf(msg.connectionId)}.`, "info");
        } catch (err) {
          this.toast(this.friendlyError(err), "error");
        }
        break;

      case "copyAllDiagnostics":
        try {
          const bundle = await this.buildDiagnosticsBundle();
          await vscode.env.clipboard.writeText(JSON.stringify(bundle, null, 2));
          this.toast("Copied full diagnostics bundle to clipboard.", "info");
        } catch (err) {
          this.toast(this.friendlyError(err), "error");
        }
        break;
    }
  }

  /** "Set up" routes per connection: Atlassian uses its credential flow, others enable + open settings. */
  private async handleSetup(connectionId: string): Promise<void> {
    if (connectionId === "atlassian") {
      await this.run(undefined, async () => {
        await this.connectionManager.signIn("atlassian");
      });
      return;
    }
    await this.run(undefined, async () => {
      await vscode.commands.executeCommand("managedConnections.enableConnection", {
        connectionId,
      });
    });
  }

  private async run(
    progressTitle: string | undefined,
    action: () => Promise<void>,
    successToast?: string
  ): Promise<void> {
    try {
      if (progressTitle) {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: progressTitle },
          action
        );
      } else {
        await action();
      }
      if (successToast) this.toast(successToast, "info");
    } catch (err) {
      this.toast(this.friendlyError(err), "error");
    } finally {
      await this.refresh();
    }
  }

  // ── State push ──────────────────────────────────────────────────────────────

  private async refresh(): Promise<void> {
    const connections = CONNECTION_REGISTRY.map((def) =>
      this.presentConnection(def, this.healthMonitor.getHealth(def.id))
    );
    const gateway = await this.presentGateway();
    this.post({ type: "stateUpdate", connections, gateway });
  }

  private presentConnection(def: ConnectionDefinition, health: ConnectionHealth | undefined) {
    const status = health?.status ?? "not_configured";
    const toolCount = health?.toolCount ?? 0;
    const hiddenTools = (health?.hiddenTools ?? []).map((t) => ({
      name: t.name,
      reason: t.reason,
      isSafe: t.isSafe,
    }));
    const friendly = FRIENDLY[def.id] ?? { icon: "🔌", description: def.description };

    return {
      id: def.id,
      name: def.name,
      icon: friendly.icon,
      description: friendly.description,
      status,
      toolCount,
      hiddenToolCount: health?.hiddenToolCount ?? 0,
      // Plain-English summary — safe for normal users (never raw protocol text).
      assistantSummary: health?.assistantSummary ?? "",
      // Raw technical text — only shown inside Technical details disclosure.
      technicalMessage: health?.technicalMessage ?? "",
      hiddenTools,
      recentLogs: health?.diagnostics?.recentLogs ?? [],
      uptimeMs: health?.uptimeMs,
      crashCount: health?.crashCount ?? 0,
      isSimulatable: def.id === "test-echo",
    };
  }

  private async presentGateway() {
    try {
      const status = await this.gatewayClient.getStatus();
      const hiddenUnsafe = status.connections.flatMap((c) =>
        (c.health.hiddenTools ?? [])
          .filter((t) => !t.isSafe)
          .map((t) => ({ connection: c.name, name: t.name, reason: t.reason }))
      );
      return {
        available: true,
        version: status.version,
        pid: status.pid,
        uptimeMs: status.uptimeMs,
        port: this.gatewayClient.port,
        connectionsJson: JSON.stringify(
          status.connections.map((c) => ({ id: c.id, name: c.name, health: c.health })),
          null,
          2
        ),
        hiddenUnsafe,
      };
    } catch {
      return { available: false, port: this.gatewayClient.port };
    }
  }

  private async buildDiagnosticsBundle() {
    const gateway = await this.presentGateway();
    const connections = CONNECTION_REGISTRY.map((def) => ({
      id: def.id,
      name: def.name,
      health: this.healthMonitor.getHealth(def.id) ?? null,
    }));
    return { capturedAt: new Date().toISOString(), gateway, connections };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private nameOf(id: string): string {
    return CONNECTION_REGISTRY.find((c) => c.id === id)?.name ?? id;
  }

  /** Keep raw protocol/process noise out of toasts; users only see friendly text. */
  private friendlyError(err: unknown): string {
    const text = String(err);
    if (/ECONNREFUSED|fetch failed|returned 5\d\d/i.test(text)) {
      return "The connection gateway isn't responding. Try Refresh, or Verify setup.";
    }
    return "Something went wrong. Open Advanced diagnostics for details.";
  }

  private post(msg: unknown): void {
    void this.panel.webview.postMessage(msg);
  }

  private toast(message: string, kind: "info" | "error"): void {
    this.post({ type: "toast", message, kind });
  }
}

type InboundMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "verifySetup" }
  | { type: "restart"; connectionId: string }
  | { type: "simulate"; connectionId: string; mode: SimulationMode }
  | { type: "signIn"; connectionId: string }
  | { type: "setup"; connectionId: string }
  | { type: "enableSafeMode"; connectionId: string }
  | { type: "openDiagnostics"; connectionId: string }
  | { type: "copyDiagnostics"; connectionId: string }
  | { type: "copyAllDiagnostics" };

/** Friendly, capability-first copy for the dashboard (overrides registry blurbs). */
const FRIENDLY: Record<string, { icon: string; description: string }> = {
  "test-echo": {
    icon: "🧪",
    description: "A built-in test connection that proves the local gateway is working end to end.",
  },
  "local-knowledge": {
    icon: "📚",
    description: "Let the assistant recall and link your project's local files and docs.",
  },
  github: {
    icon: "🐙",
    description: "Work with repositories, issues, and pull requests in your GitHub projects.",
  },
  atlassian: {
    icon: "🗂️",
    description: "Search Confluence docs and create or update Jira issues from your editor.",
  },
  playwright: {
    icon: "🌐",
    description: "Safe browser automation for navigating and reading web pages.",
  },
};

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 32; i++) result += chars[Math.floor(Math.random() * chars.length)];
  return result;
}

function buildHtml(): string {
  const nonce = getNonce();
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
  ].join("; ");

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Connections Center</title>
  <style>
    :root {
      --radius: 10px;
      --gap: 16px;
      --border: var(--vscode-panel-border, var(--vscode-input-border, #3c3c3c));
      --muted: var(--vscode-descriptionForeground, #8b949e);
      --ok: var(--vscode-testing-iconPassed, #3fb950);
      --warn: var(--vscode-editorWarning-foreground, #d29922);
      --err: var(--vscode-testing-iconFailed, #f85149);
      --info: var(--vscode-progressBar-background, #1f6feb);
    }

    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      line-height: 1.5;
    }

    .page { max-width: 960px; margin: 0 auto; padding: 32px 28px 64px; }

    /* ── Header ──────────────────────────────────────────────────── */
    .header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--gap);
      flex-wrap: wrap;
      margin-bottom: 24px;
    }
    .header h1 { font-size: 1.65em; font-weight: 600; margin: 0 0 4px; letter-spacing: -0.01em; }
    .header .subtitle { color: var(--muted); margin: 0; font-size: 0.95em; }
    .header-actions { display: flex; gap: 8px; flex-shrink: 0; }

    /* ── Buttons ─────────────────────────────────────────────────── */
    .btn {
      font-family: inherit;
      font-size: 0.85em;
      padding: 6px 14px;
      border-radius: 6px;
      border: 1px solid transparent;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      white-space: nowrap;
    }
    .btn:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
    .btn-primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .btn-primary:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground, transparent);
      color: var(--vscode-button-secondaryForeground, var(--vscode-editor-foreground));
      border-color: var(--border);
    }
    .btn-secondary:hover { background: var(--vscode-list-hoverBackground); }
    .btn-ghost {
      background: transparent;
      color: var(--vscode-textLink-foreground, var(--info));
      padding: 6px 8px;
    }
    .btn-ghost:hover { text-decoration: underline; }

    /* ── Summary strip ───────────────────────────────────────────── */
    .summary {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      margin-bottom: 24px;
    }
    .stat {
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 14px 16px;
      background: var(--vscode-editor-background);
    }
    .stat .num { font-size: 1.8em; font-weight: 700; line-height: 1; }
    .stat .lbl { color: var(--muted); font-size: 0.82em; margin-top: 6px; }
    .stat.ready .num { color: var(--ok); }
    .stat.attention .num { color: var(--warn); }
    .stat.notset .num { color: var(--muted); }
    .stat.disabled .num { color: var(--muted); }

    /* ── Needs-attention banner ──────────────────────────────────── */
    .attention-banner {
      border: 1px solid var(--warn);
      border-left-width: 4px;
      border-radius: var(--radius);
      padding: 14px 18px;
      margin-bottom: 24px;
      background: color-mix(in srgb, var(--warn) 10%, transparent);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--gap);
      flex-wrap: wrap;
    }
    .attention-banner .title { font-weight: 600; }
    .attention-banner .detail { color: var(--muted); font-size: 0.9em; margin-top: 2px; }

    /* ── Cards ───────────────────────────────────────────────────── */
    .section-title {
      font-size: 0.78em;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
      font-weight: 600;
      margin: 0 0 12px;
    }
    .cards { display: flex; flex-direction: column; gap: 12px; }
    .card {
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 18px 20px;
      background: var(--vscode-editor-background);
      transition: border-color 0.12s ease, box-shadow 0.12s ease;
    }
    .card:hover { border-color: var(--vscode-focusBorder); }
    .card:focus-within { border-color: var(--vscode-focusBorder); }

    .card-top { display: flex; align-items: flex-start; gap: 14px; }
    .card-icon {
      font-size: 1.5em;
      line-height: 1;
      width: 40px; height: 40px;
      display: flex; align-items: center; justify-content: center;
      border: 1px solid var(--border);
      border-radius: 8px;
      flex-shrink: 0;
    }
    .card-body { flex: 1; min-width: 0; }
    .card-head {
      display: flex; align-items: center; justify-content: space-between;
      gap: 12px; flex-wrap: wrap;
    }
    .card-name { font-size: 1.05em; font-weight: 600; }
    .card-desc { color: var(--muted); font-size: 0.9em; margin: 6px 0 0; }
    .card-meta { font-size: 0.82em; color: var(--muted); margin-top: 6px; }
    .card-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; align-items: center; }

    /* ── Status badge (never color-only: glyph + text) ───────────── */
    .badge {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 3px 10px; border-radius: 999px;
      font-size: 0.78em; font-weight: 600;
      border: 1px solid transparent;
    }
    .badge .glyph { font-size: 0.95em; }
    .badge.ready { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, transparent); background: color-mix(in srgb, var(--ok) 12%, transparent); }
    .badge.attention { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, transparent); background: color-mix(in srgb, var(--warn) 12%, transparent); }
    .badge.progress { color: var(--info); border-color: color-mix(in srgb, var(--info) 45%, transparent); background: color-mix(in srgb, var(--info) 12%, transparent); }
    .badge.notset, .badge.disabled { color: var(--muted); border-color: var(--border); background: var(--vscode-editor-background); }

    /* ── Disclosure (native <details> for built-in a11y) ─────────── */
    details { margin-top: 14px; border-top: 1px solid var(--border); padding-top: 10px; }
    summary {
      cursor: pointer; font-size: 0.83em; color: var(--muted);
      list-style: none; display: inline-flex; align-items: center; gap: 6px;
      padding: 2px 4px; border-radius: 4px;
    }
    summary::-webkit-details-marker { display: none; }
    summary:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
    summary::before { content: "▸"; display: inline-block; transition: transform 0.12s; }
    details[open] > summary::before { transform: rotate(90deg); }
    summary:hover { color: var(--vscode-editor-foreground); }

    .diag-grid { margin-top: 12px; display: flex; flex-direction: column; gap: 12px; }
    .diag-label {
      font-size: 0.72em; text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--muted); font-weight: 600; margin-bottom: 4px;
    }
    pre.code {
      margin: 0; padding: 10px 12px; border-radius: 6px;
      background: var(--vscode-textCodeBlock-background, var(--vscode-editor-inactiveSelectionBackground));
      font-family: var(--vscode-editor-font-family, ui-monospace, monospace);
      font-size: 0.8em; white-space: pre-wrap; word-break: break-word;
      max-height: 220px; overflow: auto;
    }
    .kv { font-size: 0.85em; }
    .kv span { color: var(--muted); }

    .sim-row { display: flex; align-items: center; gap: 8px; }
    select {
      font-family: inherit; font-size: 0.82em; padding: 5px 8px; border-radius: 6px;
      background: var(--vscode-dropdown-background, var(--vscode-input-background));
      color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
      border: 1px solid var(--vscode-dropdown-border, var(--border));
    }
    select:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 1px; }

    /* ── Global advanced diagnostics ─────────────────────────────── */
    .global-diag {
      margin-top: 28px; border: 1px solid var(--border); border-radius: var(--radius);
      padding: 4px 18px 14px;
    }

    /* ── Toasts ──────────────────────────────────────────────────── */
    #toasts {
      position: fixed; bottom: 18px; right: 18px;
      display: flex; flex-direction: column-reverse; gap: 8px; z-index: 99;
    }
    .toast {
      padding: 10px 16px; border-radius: 8px; font-size: 0.86em; max-width: 360px;
      color: #fff; box-shadow: 0 2px 10px rgba(0,0,0,0.3); animation: rise 0.18s ease;
    }
    .toast.info { background: var(--info); }
    .toast.error { background: var(--err); }
    @keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }

    .loading { color: var(--muted); padding: 60px 0; text-align: center; }

    .sr-only {
      position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
      overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
    }

    @media (max-width: 640px) {
      .summary { grid-template-columns: repeat(2, 1fr); }
    }
  </style>
</head>
<body>
  <main class="page">
    <div class="header">
      <div>
        <h1>Connections</h1>
        <p class="subtitle">Manage what the assistant can access.</p>
      </div>
      <div class="header-actions">
        <button class="btn btn-secondary" id="btn-refresh" aria-label="Refresh connections">↻ Refresh</button>
        <button class="btn btn-secondary" id="btn-verify" aria-label="Verify local setup">✓ Verify setup</button>
      </div>
    </div>

    <div id="root">
      <div class="loading" aria-live="polite">Loading connections…</div>
    </div>
  </main>

  <div id="toasts" aria-live="polite" aria-atomic="false"></div>

  <script nonce="${nonce}">
  (function () {
    "use strict";
    const vscode = acquireVsCodeApi();
    let connections = [];
    let gateway = null;
    let painted = false;

    const STATUS = {
      ready:              { label: "Connected",            kind: "ready",     glyph: "✓" },
      starting:           { label: "Starting…",            kind: "progress",  glyph: "↻" },
      stopping:           { label: "Stopping…",            kind: "progress",  glyph: "↻" },
      crashed:            { label: "Stopped unexpectedly", kind: "attention", glyph: "!" },
      degraded:           { label: "Partly working",       kind: "attention", glyph: "!" },
      auth_required:      { label: "Needs sign-in",        kind: "attention", glyph: "🔑" },
      dependency_missing: { label: "Setup needed",         kind: "attention", glyph: "!" },
      version_mismatch:   { label: "Update required",      kind: "attention", glyph: "!" },
      not_configured:     { label: "Not set up",           kind: "notset",    glyph: "○" },
      unsafe_disabled:    { label: "Disabled",             kind: "disabled",  glyph: "⊘" },
      blocked_by_policy:  { label: "Blocked by policy",    kind: "disabled",  glyph: "⊘" },
    };

    const SIM_MODES = [
      "ready","slow_start","crash_on_start","crash_after_delay","hang","bad_json",
      "auth_required","dependency_missing","version_mismatch","unsafe_tools","crash_during_tool_call",
    ];

    function esc(v) {
      return String(v == null ? "" : v)
        .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
        .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
    }
    function send(msg) { vscode.postMessage(msg); }
    function meta(s) { return STATUS[s] || STATUS.not_configured; }

    /* ── Resilient first paint: re-ping until the extension answers ── */
    let pings = 0;
    function ping() {
      if (painted || pings >= 8) return;
      pings++;
      send({ type: "ready" });
      setTimeout(ping, 400);
    }

    window.addEventListener("message", function (e) {
      const m = e.data;
      if (m.type === "stateUpdate") {
        connections = m.connections || [];
        gateway = m.gateway || null;
        painted = true;
        render();
      } else if (m.type === "toast") {
        toast(m.message, m.kind || "info");
      }
    });

    document.getElementById("btn-refresh").addEventListener("click", function () { send({ type: "refresh" }); });
    document.getElementById("btn-verify").addEventListener("click", function () { send({ type: "verifySetup" }); });

    ping();

    /* ── Render ──────────────────────────────────────────────────── */
    function render() {
      const counts = { ready: 0, attention: 0, notset: 0, disabled: 0 };
      const attention = [];
      for (const c of connections) {
        const k = meta(c.status).kind;
        if (k === "ready") counts.ready++;
        else if (k === "attention") { counts.attention++; attention.push(c); }
        else if (k === "notset") counts.notset++;
        else if (k === "disabled") counts.disabled++;
      }

      let h = "";

      /* Summary strip */
      h += '<div class="summary">';
      h += stat("ready", counts.ready, "Ready");
      h += stat("attention", counts.attention, counts.attention === 1 ? "Needs attention" : "Need attention");
      h += stat("notset", counts.notset, "Not set up");
      h += stat("disabled", counts.disabled, "Disabled");
      h += "</div>";

      /* Needs-attention banner */
      if (attention.length > 0) {
        const first = attention[0];
        const more = attention.length > 1 ? (" (+" + (attention.length - 1) + " more)") : "";
        h += '<div class="attention-banner" role="region" aria-label="Connections needing attention">';
        h += '<div><div class="title">' + attention.length + " connection" + (attention.length === 1 ? "" : "s") + " need" + (attention.length === 1 ? "s" : "") + " attention</div>";
        h += '<div class="detail">' + esc(first.name) + " — " + esc(meta(first.status).label) + "." + esc(more) + "</div></div>";
        h += '<button class="btn btn-primary" data-fix="' + esc(first.id) + '">Fix now</button>';
        h += "</div>";
      }

      /* Cards */
      h += '<p class="section-title">Capabilities</p><div class="cards">';
      for (const c of connections) h += card(c);
      h += "</div>";

      /* Global advanced diagnostics */
      h += globalDiag();

      document.getElementById("root").innerHTML = h;
      wire();
    }

    function stat(kind, num, label) {
      return '<div class="stat ' + kind + '"><div class="num">' + num + '</div><div class="lbl">' + label + "</div></div>";
    }

    function card(c) {
      const m = meta(c.status);
      let o = '<section class="card" aria-label="' + esc(c.name) + ", " + esc(m.label) + '">';
      o += '<div class="card-top">';
      o += '<div class="card-icon" aria-hidden="true">' + esc(c.icon) + "</div>";
      o += '<div class="card-body">';

      o += '<div class="card-head">';
      o += '<span class="card-name">' + esc(c.name) + "</span>";
      o += '<span class="badge ' + m.kind + '" role="status"><span class="glyph" aria-hidden="true">' + esc(m.glyph) + "</span>" + esc(m.label) + "</span>";
      o += "</div>";

      o += '<p class="card-desc">' + esc(c.description) + "</p>";

      if (c.status === "ready" && c.toolCount > 0) {
        let mt = c.toolCount + " tool" + (c.toolCount === 1 ? "" : "s") + " available";
        if (c.hiddenToolCount > 0) mt += " · " + c.hiddenToolCount + " hidden for safety";
        o += '<div class="card-meta">' + mt + "</div>";
      }

      /* Actions */
      o += '<div class="card-actions">' + actions(c).join("") + "</div>";

      /* Per-card technical details disclosure */
      o += '<details><summary>Technical details</summary><div class="diag-grid">';
      if (c.assistantSummary) o += diagBlock("Summary", c.assistantSummary, false);
      o += '<div class="kv"><span>Status:</span> ' + esc(c.status) +
           ' &nbsp; <span>Tools:</span> ' + c.toolCount + (c.hiddenToolCount ? " (" + c.hiddenToolCount + " hidden)" : "") +
           ' &nbsp; <span>Uptime:</span> ' + (c.uptimeMs != null ? Math.round(c.uptimeMs / 1000) + "s" : "n/a") +
           ' &nbsp; <span>Crashes:</span> ' + (c.crashCount || 0) + "</div>";
      if (c.technicalMessage) o += diagBlock("Last error", c.technicalMessage, true);
      if (c.hiddenTools && c.hiddenTools.length) {
        o += diagBlock("Hidden tools", c.hiddenTools.map(function (t) { return "• " + t.name + " — " + t.reason; }).join("\\n"), true);
      }
      if (c.recentLogs && c.recentLogs.length) {
        o += diagBlock("Recent logs", c.recentLogs.slice(0, 20).join("\\n"), true);
      }
      o += '<div class="card-actions" style="margin-top:4px">';
      o += '<button class="btn btn-secondary" data-act="openDiagnostics" data-id="' + esc(c.id) + '">Open full diagnostics</button>';
      o += '<button class="btn btn-secondary" data-act="copyDiagnostics" data-id="' + esc(c.id) + '">Copy diagnostics JSON</button>';
      o += "</div>";
      o += "</div></details>";

      o += "</div></div></section>";
      return o;
    }

    function actions(c) {
      const id = esc(c.id);
      const out = [];
      switch (c.status) {
        case "ready":
          out.push(btn("secondary", "restart", id, "↻ Restart"));
          if (c.isSimulatable) out.push(simControl(id));
          break;
        case "crashed":
        case "degraded":
          out.push(btn("primary", "restart", id, "↻ Restart"));
          break;
        case "auth_required":
          out.push(btn("primary", "signIn", id, "🔑 Sign in"));
          break;
        case "not_configured":
          out.push(btn("primary", "setup", id, "Set up"));
          break;
        case "dependency_missing":
          out.push(btn("primary", "setup", id, "↓ Install tools"));
          break;
        case "unsafe_disabled":
          out.push(btn("primary", "enableSafeMode", id, "Enable safe mode"));
          break;
        default:
          break;
      }
      return out;
    }

    function btn(style, act, id, label) {
      return '<button class="btn btn-' + style + '" data-act="' + act + '" data-id="' + id + '" aria-label="' + esc(label.replace(/[^a-zA-Z ]/g, "").trim()) + " " + id + '">' + label + "</button>";
    }

    function simControl(id) {
      let s = '<span class="sim-row"><label class="sr-only" for="sim-' + id + '">Simulate state for ' + id + '</label>';
      s += '<select id="sim-' + id + '" data-sim-select="' + id + '">';
      for (const mode of SIM_MODES) s += '<option value="' + mode + '">' + mode + "</option>";
      s += "</select>";
      s += '<button class="btn btn-secondary" data-act="simulate" data-id="' + id + '">Simulate</button></span>';
      return s;
    }

    function diagBlock(label, value, code) {
      let o = '<div><div class="diag-label">' + esc(label) + "</div>";
      o += code ? ('<pre class="code">' + esc(value) + "</pre>") : ('<div style="font-size:0.88em">' + esc(value) + "</div>");
      return o + "</div>";
    }

    function globalDiag() {
      let o = '<details class="global-diag"><summary>Advanced diagnostics</summary><div class="diag-grid">';
      if (gateway && gateway.available) {
        o += '<div class="kv"><span>Gateway:</span> running &nbsp; <span>Version:</span> ' + esc(gateway.version) +
             ' &nbsp; <span>PID:</span> ' + esc(gateway.pid) +
             ' &nbsp; <span>Port:</span> ' + esc(gateway.port) +
             ' &nbsp; <span>Uptime:</span> ' + (gateway.uptimeMs != null ? Math.round(gateway.uptimeMs / 1000) + "s" : "n/a") + "</div>";
        if (gateway.hiddenUnsafe && gateway.hiddenUnsafe.length) {
          o += diagBlock("Hidden unsafe tools", gateway.hiddenUnsafe.map(function (t) { return "• [" + t.connection + "] " + t.name + " — " + t.reason; }).join("\\n"), true);
        } else {
          o += diagBlock("Hidden unsafe tools", "None exposed by any downstream server.", false);
        }
        if (gateway.connectionsJson) o += diagBlock("Connection state (JSON)", gateway.connectionsJson, true);
      } else {
        o += '<div class="kv"><span>Gateway:</span> not responding &nbsp; <span>Port:</span> ' + esc(gateway ? gateway.port : "?") + "</div>";
      }
      o += '<div class="card-actions"><button class="btn btn-secondary" data-act="copyAllDiagnostics">Copy diagnostics JSON</button></div>';
      o += "</div></details>";
      return o;
    }

    /* ── Wiring ──────────────────────────────────────────────────── */
    function wire() {
      document.querySelectorAll("[data-act]").forEach(function (el) {
        el.addEventListener("click", function () {
          const act = el.getAttribute("data-act");
          const id = el.getAttribute("data-id");
          if (act === "simulate") {
            const sel = document.querySelector('[data-sim-select="' + id + '"]');
            send({ type: "simulate", connectionId: id, mode: sel ? sel.value : "ready" });
          } else if (act === "copyAllDiagnostics") {
            send({ type: "copyAllDiagnostics" });
          } else {
            send({ type: act, connectionId: id });
          }
        });
      });
      document.querySelectorAll("[data-fix]").forEach(function (el) {
        el.addEventListener("click", function () {
          const id = el.getAttribute("data-fix");
          const conn = connections.find(function (c) { return c.id === id; });
          if (!conn) return;
          const primary = actionTypeFor(conn.status);
          if (primary) send({ type: primary, connectionId: id });
        });
      });
    }

    function actionTypeFor(status) {
      switch (status) {
        case "crashed":
        case "degraded": return "restart";
        case "auth_required": return "signIn";
        case "not_configured": return "setup";
        case "dependency_missing": return "setup";
        case "unsafe_disabled": return "enableSafeMode";
        default: return null;
      }
    }

    /* ── Toast ───────────────────────────────────────────────────── */
    function toast(message, kind) {
      const c = document.getElementById("toasts");
      const el = document.createElement("div");
      el.className = "toast " + kind;
      el.setAttribute("role", "alert");
      el.textContent = message;
      c.appendChild(el);
      setTimeout(function () { el.remove(); }, 4200);
    }
  })();
  </script>
</body>
</html>`;
}
