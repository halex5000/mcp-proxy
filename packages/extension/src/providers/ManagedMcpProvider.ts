import * as vscode from "vscode";
import type { GatewayProcess } from "../gateway/GatewayProcess.js";

/**
 * ManagedMcpProvider implements VS Code's McpServerDefinitionProvider API.
 *
 * It registers a SINGLE managed entry point: the gateway process.
 * VS Code connects to the gateway via stdio, and the gateway internally
 * manages all downstream MCP servers.
 *
 * This is the critical seam: by registering the gateway here instead of
 * individual servers, we get:
 *  - Centralized health management
 *  - Unified tool namespace
 *  - Zero manual mcp.json editing
 *  - Hot-reload of downstream server configs without disrupting the Copilot session
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

    // When the gateway crashes and restarts, tell VS Code to re-fetch definitions.
    // In practice VS Code will reconnect to the new process automatically if we
    // fire this event.
    gatewayProcess.onCrash(() => {
      this._onDidChangeMcpServerDefinitions.fire();
    });

    gatewayProcess.onReady(() => {
      this._onDidChangeMcpServerDefinitions.fire();
    });
  }

  provideMcpServerDefinitions(
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.McpServerDefinition[]> {
    if (!this.gatewayProcess.isRunning) {
      return [];
    }

    // Return a single stdio server definition: the gateway process.
    // VS Code will spawn it separately; the GatewayProcess class tracks the
    // extension-side instance for the control API.
    //
    // Note: VS Code spawns the process itself based on this definition.
    // The extension's GatewayProcess class is a parallel instance used ONLY
    // for the control API (health polling, restarts, diagnostics).
    // The definition below is what VS Code actually runs for MCP communication.
    const definition = new vscode.StdioMcpServerDefinition(
      "Managed Connections",
      process.execPath,
      [this.getGatewayBundlePath()],
      {
        NODE_ENV: "production",
        // VS Code's process is the MCP stdio gateway; the extension's
        // GatewayProcess instance runs a SEPARATE control-only copy.
        GATEWAY_MODE: "mcp",
      }
    );

    return [definition];
  }

  private getGatewayBundlePath(): string {
    // Resolved at runtime relative to extension installation path.
    // In development this is packages/gateway/dist/index.js.
    const ext = vscode.extensions.getExtension("your-publisher.managed-mcp-connections");
    if (!ext) {
      throw new Error("Cannot resolve own extension path");
    }
    const path = require("path") as typeof import("path");
    return path.join(ext.extensionPath, "dist", "gateway", "index.js");
  }

  dispose(): void {
    this._onDidChangeMcpServerDefinitions.dispose();
  }
}
