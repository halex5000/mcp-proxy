/**
 * Extension activation entry point.
 *
 * What happens here, in order:
 *   1. Spawn the gateway process (our local MCP supervisor)
 *   2. Wait for the gateway to announce its control port
 *   3. Register the gateway as a VS Code McpServerDefinitionProvider
 *      (VS Code/Copilot will connect to the gateway's MCP stdio interface)
 *   4. Push the initial connection configuration to the gateway
 *   5. Start the health monitor (polls the gateway control API every 5s)
 *   6. Register the Connections tree view
 *   7. Register all commands
 *
 * Users see: a "Connections" panel in the sidebar. Nothing else.
 * Copilot sees: a single MCP server (the gateway) with aggregated tools.
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
    vscode.window.showErrorMessage(
      `Managed Connections failed to start: ${err}. Click "Show Output" to diagnose.`,
      "Show Output"
    ).then((choice) => {
      if (choice === "Show Output") gatewayProcess.showOutput();
    });
    return;
  }

  // ── 2. Control API client ─────────────────────────────────────────────────
  const gatewayClient = new GatewayClient(gatewayPort, gatewayProcess.authToken);

  // ── 3. Register the gateway as an MCP server provider ────────────────────
  //
  // This is the critical registration: VS Code sees ONE MCP server (the gateway),
  // not individual downstream servers. The gateway internally manages all connections.
  //
  const mcpProvider = new ManagedMcpProvider(gatewayProcess);
  context.subscriptions.push(
    vscode.lm.registerMcpServerDefinitionProvider(
      "managed-connections",
      mcpProvider
    )
  );

  // ── 4. Connection manager — push initial config to gateway ────────────────
  const connectionManager = new ConnectionManager(gatewayClient, context);
  context.subscriptions.push(connectionManager);

  try {
    await connectionManager.pushConfig();
  } catch (err) {
    // Non-fatal: gateway may not be fully initialized yet.
    // The health monitor will retry and surface any issues.
    console.warn("Initial config push failed:", err);
  }

  // ── 5. Health monitor ─────────────────────────────────────────────────────
  const healthMonitor = new HealthMonitor(gatewayClient);
  context.subscriptions.push(healthMonitor);
  healthMonitor.start();

  // Show a status bar notification when a connection needs attention
  healthMonitor.onHealthChanged(({ health }) => {
    if (health.status === "crashed") {
      vscode.window
        .showWarningMessage(
          `A connection crashed: ${health.message}`,
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
          `A connection needs sign-in: ${health.message}`,
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
    {
      treeDataProvider: treeProvider,
      showCollapseAll: false,
    }
  );
  context.subscriptions.push(treeView);

  // ── 7. Diagnostics panel ──────────────────────────────────────────────────
  const diagnosticsPanel = new DiagnosticsPanel(gatewayClient);

  // ── 8. Commands ───────────────────────────────────────────────────────────
  registerCommands(context, {
    treeProvider,
    connectionManager,
    gatewayClient,
    gatewayProcess,
    diagnosticsPanel,
  });

  // ── Done. Show a subtle ready indicator. ──────────────────────────────────
  // We deliberately avoid a notification toast here — ready state is the
  // expected default. Only problems warrant user attention.
}

export function deactivate(): void {
  // VS Code calls dispose() on all context.subscriptions automatically.
  // The GatewayProcess.dispose() kills the gateway child process.
}
