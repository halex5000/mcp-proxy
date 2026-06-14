import * as vscode from "vscode";
import type { ConnectionManager } from "../connections/ConnectionManager.js";
import type { ConnectionsTreeProvider } from "../providers/ConnectionsTreeProvider.js";
import type { ConnectionTreeItem } from "../providers/ConnectionsTreeProvider.js";
import type { GatewayClient } from "../gateway/GatewayClient.js";
import type { GatewayProcess } from "../gateway/GatewayProcess.js";
import type { DiagnosticsPanel } from "../ui/DiagnosticsPanel.js";
import type { ConnectionId } from "@mcp-proxy/shared";

export function registerCommands(
  context: vscode.ExtensionContext,
  opts: {
    treeProvider: ConnectionsTreeProvider;
    connectionManager: ConnectionManager;
    gatewayClient: GatewayClient;
    gatewayProcess: GatewayProcess;
    diagnosticsPanel: DiagnosticsPanel;
  }
): void {
  const { treeProvider, connectionManager, gatewayClient, gatewayProcess, diagnosticsPanel } =
    opts;

  context.subscriptions.push(
    vscode.commands.registerCommand("managedConnections.refresh", () => {
      treeProvider.refresh();
    }),

    vscode.commands.registerCommand(
      "managedConnections.restart",
      async (item?: ConnectionTreeItem) => {
        const id = item?.connectionId ?? (await pickConnection("Restart which connection?"));
        if (!id) return;
        await withProgress(`Restarting ${id}…`, async () => {
          await gatewayClient.restart(id);
          treeProvider.refresh();
        });
      }
    ),

    vscode.commands.registerCommand(
      "managedConnections.openDiagnostics",
      async (item?: ConnectionTreeItem) => {
        const id = item?.connectionId ?? (await pickConnection("Open diagnostics for which connection?"));
        if (!id) return;
        const name = item?.label as string ?? id;
        await diagnosticsPanel.open(id, name);
      }
    ),

    vscode.commands.registerCommand(
      "managedConnections.signIn",
      async (item?: ConnectionTreeItem) => {
        const id = item?.connectionId ?? (await pickConnection("Sign in to which connection?"));
        if (!id) return;
        await connectionManager.signIn(id);
        treeProvider.refresh();
      }
    ),

    vscode.commands.registerCommand(
      "managedConnections.signOut",
      async (item?: ConnectionTreeItem) => {
        const id = item?.connectionId ?? (await pickConnection("Sign out of which connection?"));
        if (!id) return;
        await connectionManager.signOut(id);
        treeProvider.refresh();
      }
    ),

    vscode.commands.registerCommand(
      "managedConnections.openSettings",
      async (item?: ConnectionTreeItem) => {
        const id = item?.connectionId;
        if (id) {
          await vscode.commands.executeCommand(
            "workbench.action.openSettings",
            `managedConnections.${id}`
          );
        } else {
          await vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "managedConnections"
          );
        }
      }
    ),

    vscode.commands.registerCommand(
      "managedConnections.enableConnection",
      async (item?: ConnectionTreeItem) => {
        const id = item?.connectionId;
        if (!id) return;
        await toggleConnection(id, true);
        treeProvider.refresh();
      }
    ),

    vscode.commands.registerCommand(
      "managedConnections.disableConnection",
      async (item?: ConnectionTreeItem) => {
        const id = item?.connectionId;
        if (!id) return;
        await toggleConnection(id, false);
        treeProvider.refresh();
      }
    ),

    vscode.commands.registerCommand(
      "managedConnections.installDependency",
      async (item?: ConnectionTreeItem) => {
        const id = item?.connectionId;
        if (!id) return;
        // Open a terminal and run the install command for the connection.
        const terminal = vscode.window.createTerminal("Connection Setup");
        terminal.show();
        // The install command is defined in ConnectionRegistry per-connection.
        // This is a simplified version; real impl would look up the definition.
        terminal.sendText(`npx --yes @modelcontextprotocol/server-filesystem --version`);
      }
    ),

    vscode.commands.registerCommand(
      "managedConnections.resetConnectionState",
      async (item?: ConnectionTreeItem) => {
        const id = item?.connectionId;
        if (!id) return;
        const confirm = await vscode.window.showWarningMessage(
          `Reset all state for "${id}"? This will clear auth tokens and restart the connection.`,
          { modal: true },
          "Reset"
        );
        if (confirm === "Reset") {
          await connectionManager.signOut(id);
          await gatewayClient.restart(id);
          treeProvider.refresh();
        }
      }
    ),

    vscode.commands.registerCommand("managedConnections.showGatewayOutput", () => {
      gatewayProcess.showOutput();
    })
  );
}

async function pickConnection(prompt: string): Promise<ConnectionId | undefined> {
  // Import here to avoid circular dep at module load time
  const { CONNECTION_REGISTRY } = await import("../connections/ConnectionRegistry.js");
  const picks = CONNECTION_REGISTRY.map((c) => ({ label: c.name, id: c.id }));
  const picked = await vscode.window.showQuickPick(picks, {
    placeHolder: prompt,
    matchOnDescription: true,
  });
  return picked?.id as ConnectionId | undefined;
}

async function toggleConnection(id: ConnectionId, enable: boolean): Promise<void> {
  const config = vscode.workspace.getConfiguration("managedConnections");
  const current: string[] = config.get("enabledConnections") ?? [];
  const next = enable
    ? [...new Set([...current, id])]
    : current.filter((c) => c !== id);
  await config.update("enabledConnections", next, vscode.ConfigurationTarget.Workspace);
}

async function withProgress(title: string, fn: () => Promise<void>): Promise<void> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title },
    fn
  );
}
