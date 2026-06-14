import * as vscode from "vscode";
import { authHeader } from "@mcp-proxy/shared";
import type { GatewayProcess } from "../gateway/GatewayProcess.js";

/**
 * ManagedMcpProvider implements VS Code's McpServerDefinitionProvider API.
 *
 * It registers a SINGLE managed entry point: the gateway's /mcp HTTP endpoint.
 * Crucially this is an *HTTP* definition, not a stdio one. The difference is the
 * whole architecture:
 *
 *   - With McpStdioServerDefinition, VS Code spawns and owns the process. The
 *     extension would then be monitoring/restarting a DIFFERENT process than the
 *     one Copilot talks to (the extension spawns its own for the control API).
 *
 *   - With McpHttpServerDefinition, VS Code is just an HTTP client. The extension
 *     spawns the one and only gateway process, owns its lifecycle, and points
 *     VS Code at its localhost /mcp endpoint. Health, restart, and diagnostics
 *     all act on the exact process Copilot uses.
 *
 * Benefits this unlocks:
 *   - Downstream connection restarts happen inside the gateway; the /mcp endpoint
 *     stays up, so Copilot's MCP session is never torn down.
 *   - The bearer token (passed in headers) ensures only VS Code's registered
 *     client can reach /mcp.
 *   - A full gateway restart changes the port; we fire onDidChange so VS Code
 *     reconnects to the new URI.
 */
export class ManagedMcpProvider
  implements vscode.McpServerDefinitionProvider
{
  private gatewayProcess: GatewayProcess;
  private _onDidChangeMcpServerDefinitions = new vscode.EventEmitter<void>();
  readonly onDidChangeMcpServerDefinitions =
    this._onDidChangeMcpServerDefinitions.event;

  constructor(gatewayProcess: GatewayProcess) {
    this.gatewayProcess = gatewayProcess;

    // On (re)start the port may change → tell VS Code to re-fetch definitions
    // so it reconnects to the new localhost URI.
    gatewayProcess.onReady(() => {
      this._onDidChangeMcpServerDefinitions.fire();
    });
    gatewayProcess.onCrash(() => {
      this._onDidChangeMcpServerDefinitions.fire();
    });
  }

  /**
   * Called eagerly by VS Code. Must NOT perform user interaction (auth etc.) —
   * that belongs in resolveMcpServerDefinition. We only return the localhost
   * endpoint of the already-running gateway.
   */
  provideMcpServerDefinitions(
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.McpServerDefinition[]> {
    const uri = this.gatewayProcess.mcpUri;
    if (!this.gatewayProcess.isRunning || !uri) {
      return [];
    }

    const definition = new vscode.McpHttpServerDefinition(
      "Managed Connections",
      vscode.Uri.parse(uri),
      authHeader(this.gatewayProcess.authToken),
      "0.1.0"
    );

    return [definition];
  }

  /**
   * Called when VS Code is about to start/connect the server. This is where
   * user-interactive work (auth) would go. For the local gateway there is
   * nothing to resolve — downstream auth is handled by the extension pushing
   * tokens over the control API — so we return the definition unchanged.
   */
  resolveMcpServerDefinition(
    server: vscode.McpServerDefinition,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.McpServerDefinition> {
    return server;
  }

  dispose(): void {
    this._onDidChangeMcpServerDefinitions.dispose();
  }
}
