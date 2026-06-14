/**
 * Extension activation entry point.
 *
 * Startup sequence:
 *   1. Spawn the gateway process (single local MCP supervisor)
 *   2. Register the gateway + GitHub remote MCP via McpHttpServerDefinition
 *   3. Push initial connection configuration to the gateway
 *   4. Start the health monitor (gateway + remote connections)
 *   5. Register the Connections tree view
 *   6. Register all commands
 */

import * as vscode from "vscode";
import { GatewayProcess } from "./gateway/GatewayProcess.js";
import { GatewayClient } from "./gateway/GatewayClient.js";
import { ConnectionManager } from "./connections/ConnectionManager.js";
import { ManagedMcpProvider } from "./providers/ManagedMcpProvider.js";
import { ConnectionsTreeProvider } from "./providers/ConnectionsTreeProvider.js";
import { HealthMonitor } from "./health/HealthMonitor.js";
import { DiagnosticsPanel } from "./ui/DiagnosticsPanel.js";
import { registerCommands } from "./commands/registerCommands.js";

export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  // ── 1. Spawn gateway ──────────────────────────────────────────────────────
  const gatewayProcess = new GatewayProcess(context);
  context.subscriptions.push(gatewayProcess);

  let gatewayPort: number;
  try {
    gatewayPort = await gatewayProcess.start();
  } catch (err) {
    vscode.window
      .showErrorMessage(
        `Managed Connections failed to start: ${err}. Click "Show Output" to diagnose.`,
        "Show Output"
      )
      .then((choice) => {
        if (choice === "Show Output") gatewayProcess.showOutput();
      });
    return;
  }

  // ── 2. Clients and managers ───────────────────────────────────────────────
  const gatewayClient = new GatewayClient(gatewayPort, gatewayProcess.authToken);
  const connectionManager = new ConnectionManager(gatewayClient, context);
  context.subscriptions.push(connectionManager);

  // ── 3. Register MCP endpoints with VS Code ────────────────────────────────
  //
  // Returns two definitions:
  //   - Local gateway (http://127.0.0.1:<port>/mcp) — local-knowledge, atlassian, playwright
  //   - GitHub remote MCP (api.githubcopilot.com/mcp/) — GitHub tools
  //
  const mcpProvider = new ManagedMcpProvider(gatewayProcess, connectionManager);
  context.subscriptions.push(
    vscode.lm.registerMcpServerDefinitionProvider("managed-connections", mcpProvider)
  );

  // ── 4. Push initial config to gateway ────────────────────────────────────
  try {
    await connectionManager.pushConfig();
  } catch (err) {
    console.warn("Initial config push failed (gateway may still be initializing):", err);
  }

  // ── 5. Health monitor ─────────────────────────────────────────────────────
  const healthMonitor = new HealthMonitor(gatewayClient);
  context.subscriptions.push(healthMonitor);
  healthMonitor.start();

  healthMonitor.onHealthChanged(({ id, health }) => {
    if (health.status === "crashed") {
      vscode.window
        .showWarningMessage(
          `Connection "${id}" crashed: ${health.message}`,
          "Restart",
          "Diagnostics"
        )
        .then((choice) => {
          if (choice === "Restart") {
            vscode.commands.executeCommand("managedConnections.restart");
          } else if (choice === "Diagnostics") {
            vscode.commands.executeCommand("managedConnections.openDiagnostics");
          }
        });
    }
    if (health.status === "auth_required") {
      vscode.window
        .showInformationMessage(
          `"${id}" needs sign-in: ${health.message}`,
          "Sign In"
        )
        .then((choice) => {
          if (choice === "Sign In") {
            vscode.commands.executeCommand("managedConnections.signIn");
          }
        });
    }
  });

  // ── 6. Tree view ──────────────────────────────────────────────────────────
  const treeProvider = new ConnectionsTreeProvider(healthMonitor);
  const treeView = vscode.window.createTreeView(
    "managedConnections.connectionsView",
    { treeDataProvider: treeProvider, showCollapseAll: false }
  );
  context.subscriptions.push(treeView);

  // ── 7. Diagnostics panel + commands ──────────────────────────────────────
  const diagnosticsPanel = new DiagnosticsPanel(gatewayClient);

  registerCommands(context, {
    treeProvider,
    connectionManager,
    gatewayClient,
    gatewayProcess,
    diagnosticsPanel,
  });
}

export function deactivate(): void {
  // VS Code disposes all context.subscriptions automatically.
}
