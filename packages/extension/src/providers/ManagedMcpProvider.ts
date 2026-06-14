import * as vscode from "vscode";
import { authHeader } from "@mcp-proxy/shared";
import type { GatewayProcess } from "../gateway/GatewayProcess.js";
import type { ConnectionManager } from "../connections/ConnectionManager.js";
import { findConnection } from "../connections/ConnectionRegistry.js";

const GITHUB_SCOPES = ["repo", "read:org", "read:user"];

// Stable label used to identify the GitHub definition across provide/resolve calls.
const GITHUB_LABEL = "GitHub (Managed)";
const GATEWAY_LABEL = "Managed Connections";

/**
 * ManagedMcpProvider registers ALL managed MCP endpoints with VS Code.
 *
 * It returns multiple McpServerDefinitions per call:
 *
 *   1. The local gateway (McpHttpServerDefinition, localhost)
 *      Handles: local-knowledge, atlassian, playwright
 *      Auth: per-session bearer token
 *
 *   2. GitHub remote MCP (McpHttpServerDefinition, api.githubcopilot.com)
 *      Handles: GitHub issues, PRs, code search, repos
 *      Auth: injected in resolveMcpServerDefinition via VS Code auth session
 *
 * provideMcpServerDefinitions: called eagerly, no user interaction allowed.
 *   Returns definitions with placeholder auth for remote servers.
 *
 * resolveMcpServerDefinition: called when VS Code is about to connect.
 *   Injects real auth tokens. For GitHub, silently fetches the VS Code session.
 *   For the gateway, no-op (auth is already baked into the definition).
 */
export class ManagedMcpProvider implements vscode.McpServerDefinitionProvider {
  private gatewayProcess: GatewayProcess;
  private connectionManager: ConnectionManager;

  private _onDidChangeMcpServerDefinitions = new vscode.EventEmitter<void>();
  readonly onDidChangeMcpServerDefinitions =
    this._onDidChangeMcpServerDefinitions.event;

  constructor(gatewayProcess: GatewayProcess, connectionManager: ConnectionManager) {
    this.gatewayProcess = gatewayProcess;
    this.connectionManager = connectionManager;

    gatewayProcess.onReady(() => this._onDidChangeMcpServerDefinitions.fire());
    gatewayProcess.onCrash(() => this._onDidChangeMcpServerDefinitions.fire());
  }

  provideMcpServerDefinitions(
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.McpServerDefinition[]> {
    const definitions: vscode.McpServerDefinition[] = [];

    // 1. Local gateway — always included when running
    const uri = this.gatewayProcess.mcpUri;
    if (this.gatewayProcess.isRunning && uri) {
      definitions.push(
        new vscode.McpHttpServerDefinition(
          GATEWAY_LABEL,
          vscode.Uri.parse(uri),
          authHeader(this.gatewayProcess.authToken),
          "0.1.0"
        )
      );
    }

    // 2. GitHub remote MCP — included when the connection is enabled.
    // Token is injected in resolveMcpServerDefinition; we return empty headers
    // here because provideMcpServerDefinitions must not prompt the user.
    const settings = vscode.workspace.getConfiguration("managedConnections");
    const enabledIds: string[] = settings.get("enabledConnections") ?? ["github", "local-knowledge"];
    const githubDef = findConnection("github");

    if (githubDef && enabledIds.includes("github") && githubDef.baseUrl) {
      definitions.push(
        new vscode.McpHttpServerDefinition(
          GITHUB_LABEL,
          vscode.Uri.parse(githubDef.baseUrl),
          {}, // auth injected below
          "1.0.0"
        )
      );
    }

    return definitions;
  }

  /**
   * Called by VS Code immediately before connecting to each server.
   * Safe to perform auth here — VS Code shows a "Connecting…" indicator.
   */
  async resolveMcpServerDefinition(
    server: vscode.McpServerDefinition,
    _token: vscode.CancellationToken
  ): Promise<vscode.McpServerDefinition> {
    if (!(server instanceof vscode.McpHttpServerDefinition)) {
      return server;
    }

    // Inject GitHub token
    if (server.label === GITHUB_LABEL) {
      const token = await this.connectionManager.getGitHubToken();
      if (token) {
        return new vscode.McpHttpServerDefinition(
          GITHUB_LABEL,
          server.uri,
          { Authorization: `Bearer ${token}` },
          server.version
        );
      }
      // No token — return as-is; VS Code will attempt to connect and fail,
      // which surfaces as auth_required in the health view via RemoteHealthChecker.
    }

    return server;
  }

  dispose(): void {
    this._onDidChangeMcpServerDefinitions.dispose();
  }
}
