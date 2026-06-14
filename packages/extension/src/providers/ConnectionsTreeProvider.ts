import * as vscode from "vscode";
import type { HealthMonitor } from "../health/HealthMonitor.js";
import type { ConnectionHealth } from "@mcp-proxy/shared";
import type { ConnectionId } from "@mcp-proxy/shared";
import { CONNECTION_REGISTRY } from "../connections/ConnectionRegistry.js";
import {
  presentConnection,
  presentConnectionInfoItems,
} from "./ConnectionPresentation.js";

/**
 * ConnectionsTreeProvider drives the Connections side panel.
 *
 * The tree has two levels:
 *   1. Connection items (GitHub, Jira, Browser Automation…)
 *   2. Tool items under each connection (shown when health is "ready")
 *
 * Status icons and inline actions are driven entirely by the health model —
 * nothing connection-specific lives in the view layer.
 */
export class ConnectionsTreeProvider
  implements vscode.TreeDataProvider<ConnectionTreeItem>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    ConnectionTreeItem | undefined | null | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private healthMonitor: HealthMonitor;

  constructor(healthMonitor: HealthMonitor) {
    this.healthMonitor = healthMonitor;

    healthMonitor.onHealthChanged(() => {
      this._onDidChangeTreeData.fire();
    });
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ConnectionTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ConnectionTreeItem): ConnectionTreeItem[] {
    if (!element) {
      return this.buildConnectionItems();
    }
    if (element.kind === "connection" && element.health?.status === "ready") {
      return this.buildToolItems(element.connectionId!, element.health);
    }
    return [];
  }

  private buildConnectionItems(): ConnectionTreeItem[] {
    return CONNECTION_REGISTRY.map((def) => {
      const health = this.healthMonitor.getHealth(def.id);
      return new ConnectionTreeItem({
        kind: "connection",
        label: def.name,
        connectionId: def.id,
        health,
        collapsibleState:
          health?.status === "ready" && health.toolCount > 0
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None,
      });
    });
  }

  private buildToolItems(
    connectionId: ConnectionId,
    health: ConnectionHealth
  ): ConnectionTreeItem[] {
    return presentConnectionInfoItems(health).map(
      (item) =>
        new ConnectionTreeItem({
          kind: "info",
          label: item.label,
          iconId: item.iconId,
          connectionId,
          health,
          collapsibleState: vscode.TreeItemCollapsibleState.None,
        })
    );
  }
}

interface ConnectionTreeItemOptions {
  kind: "connection" | "info";
  label: string;
  iconId?: string;
  connectionId?: ConnectionId;
  health?: ConnectionHealth;
  collapsibleState: vscode.TreeItemCollapsibleState;
}

export class ConnectionTreeItem extends vscode.TreeItem {
  kind: "connection" | "info";
  connectionId?: ConnectionId;
  health?: ConnectionHealth;

  constructor(opts: ConnectionTreeItemOptions) {
    super(opts.label, opts.collapsibleState);

    this.kind = opts.kind;
    this.connectionId = opts.connectionId;
    this.health = opts.health;

    if (opts.kind === "connection" && opts.health) {
      const presentation = presentConnection(opts.health);
      this.description = presentation.description;
      this.tooltip = new vscode.MarkdownString(presentation.tooltipMarkdown);
      this.iconPath = presentation.iconColor
        ? new vscode.ThemeIcon(
            presentation.iconId,
            new vscode.ThemeColor(presentation.iconColor)
          )
        : new vscode.ThemeIcon(presentation.iconId);
      this.contextValue = presentation.contextValue;
    } else if (opts.kind === "info") {
      this.iconPath = new vscode.ThemeIcon(opts.iconId ?? "info");
      this.contextValue = "tool-info";
    }
  }
}
