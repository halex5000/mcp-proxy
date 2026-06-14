import * as vscode from "vscode";
import type { GatewayClient } from "../gateway/GatewayClient.js";
import type { ConnectionId } from "@mcp-proxy/shared";
import type { StructuredDiagnostics } from "@mcp-proxy/shared";

/**
 * DiagnosticsPanel renders a webview with structured diagnostic output for a
 * single connection. It's the "advanced" view — users only land here when they
 * click "Open Diagnostics" or when Copilot surfaces it as a next step.
 *
 * Normal users see friendly status messages in the tree view.
 * Power users see raw logs, error traces, and environment info here.
 */
export class DiagnosticsPanel {
  private panel: vscode.WebviewPanel | null = null;
  private client: GatewayClient;

  constructor(client: GatewayClient) {
    this.client = client;
  }

  async open(connectionId: ConnectionId, connectionName: string): Promise<void> {
    if (this.panel) {
      this.panel.reveal();
    } else {
      this.panel = vscode.window.createWebviewPanel(
        "managedConnections.diagnostics",
        `Diagnostics — ${connectionName}`,
        vscode.ViewColumn.Beside,
        { enableScripts: false }
      );

      this.panel.onDidDispose(() => {
        this.panel = null;
      });
    }

    await this.refresh(connectionId, connectionName);
  }

  private async refresh(
    connectionId: ConnectionId,
    connectionName: string
  ): Promise<void> {
    if (!this.panel) return;

    let diagnostics: StructuredDiagnostics | null = null;
    let errorMessage: string | null = null;

    try {
      diagnostics = await this.client.getDiagnostics(connectionId);
    } catch (err) {
      errorMessage = String(err);
    }

    this.panel.webview.html = this.renderHtml(
      connectionName,
      diagnostics,
      errorMessage
    );
  }

  private renderHtml(
    name: string,
    diag: StructuredDiagnostics | null,
    error: string | null
  ): string {
    const body = diag
      ? this.renderDiagnostics(diag)
      : `<p class="error">Could not load diagnostics: ${escapeHtml(error ?? "unknown error")}</p>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Diagnostics — ${escapeHtml(name)}</title>
  <style>
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; }
    h1 { font-size: 1.2em; margin-bottom: 4px; }
    h2 { font-size: 1em; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; margin-top: 24px; }
    .summary { background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-textBlockQuote-border); padding: 8px 12px; margin: 12px 0; border-radius: 2px; }
    .log-block { font-family: var(--vscode-editor-font-family); font-size: 0.85em; background: var(--vscode-terminal-background); padding: 8px; border-radius: 2px; overflow-x: auto; white-space: pre; max-height: 300px; overflow-y: auto; }
    .stderr { color: var(--vscode-errorForeground); }
    .error { color: var(--vscode-errorForeground); }
    table { border-collapse: collapse; width: 100%; }
    td, th { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); font-size: 0.9em; }
    th { opacity: 0.7; font-weight: normal; }
  </style>
</head>
<body>
  <h1>Diagnostics — ${escapeHtml(name)}</h1>
  ${body}
</body>
</html>`;
  }

  private renderDiagnostics(diag: StructuredDiagnostics): string {
    const logLines = diag.recentLogs
      .map((l) => {
        const isErr = l.startsWith("[stderr]");
        return `<span class="${isErr ? "stderr" : ""}">${escapeHtml(l)}</span>`;
      })
      .join("\n");

    const envRows = Object.entries(diag.environment)
      .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`)
      .join("");

    return `
      <div class="summary">${escapeHtml(diag.assistantSummary)}</div>

      <h2>Status</h2>
      <table>
        <tr><th>Tools visible</th><td>${diag.toolCount}</td></tr>
        <tr><th>Tools hidden</th><td>${diag.hiddenToolCount}</td></tr>
        <tr><th>Crash count</th><td>${diag.crashCount}</td></tr>
        ${diag.serverVersion ? `<tr><th>Server version</th><td>${escapeHtml(diag.serverVersion)}</td></tr>` : ""}
        ${diag.runtimeVersion ? `<tr><th>Runtime</th><td>${escapeHtml(diag.runtimeVersion)}</td></tr>` : ""}
      </table>

      ${
        diag.lastError
          ? `<h2>Last Error</h2><div class="log-block stderr">${escapeHtml(diag.lastError)}</div>`
          : ""
      }

      <h2>Recent Logs</h2>
      <div class="log-block">${logLines || "(no logs)"}</div>

      ${
        Object.keys(diag.environment).length > 0
          ? `<h2>Environment</h2><table>${envRows}</table>`
          : ""
      }
    `;
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
