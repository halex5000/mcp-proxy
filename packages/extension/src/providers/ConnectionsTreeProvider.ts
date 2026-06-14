import * as vscode from "vscode";
import type { HealthMonitor } from "../health/HealthMonitor.js";
import type { ConnectionHealth, ConnectionHealthStatus } from "@mcp-proxy/shared";
import type { ConnectionId } from "@mcp-proxy/shared";
import { CONNECTION_REGISTRY } from "../connections/ConnectionRegistry.js";

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
    if (health.toolCount === 0) return [];
    return [
      new ConnectionTreeItem({
        kind: "info",
        label: `${health.toolCount} tools available`,
        connectionId,
        health,
        collapsibleState: vscode.TreeItemCollapsibleState.None,
      }),
      ...(health.hiddenToolCount > 0
        ? [
            new ConnectionTreeItem({
              kind: "info",
              label: `${health.hiddenToolCount} tools hidden (safe mode)`,
              connectionId,
              health,
              collapsibleState: vscode.TreeItemCollapsibleState.None,
            }),
          ]
        : []),
    ];
  }
}

interface ConnectionTreeItemOptions {
  kind: "connection" | "info";
  label: string;
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
      this.description = opts.health.label;
      this.tooltip = new vscode.MarkdownString(
        this.buildTooltip(opts.health)
      );
      this.iconPath = this.iconForStatus(opts.health.status);
      // contextValue drives which inline actions appear via menus in package.json
      this.contextValue = `connection-${opts.health.status}`;
    } else if (opts.kind === "info") {
      this.iconPath = new vscode.ThemeIcon("info");
      this.contextValue = "tool-info";
    }
  }

  private buildTooltip(health: ConnectionHealth): string {
    const lines = [`**${health.label}**`, "", health.message];
    if (health.detail) lines.push("", `_${health.detail}_`);
    if (health.toolCount > 0) lines.push("", `${health.toolCount} tools available`);
    if (health.hiddenToolCount > 0) {
      lines.push(`${health.hiddenToolCount} tools hidden by safe mode`);
    }
    if (health.crashCount > 0) {
      lines.push("", `Crashed ${health.crashCount} time(s) since last restart`);
    }
    return lines.join("\n");
  }

  private iconForStatus(status: ConnectionHealthStatus): vscode.ThemeIcon {
    switch (status) {
      case "ready":
        return new vscode.ThemeIcon("check", new vscode.ThemeColor("testing.iconPassed"));
      case "starting":
      case "stopping":
        return new vscode.ThemeIcon("loading~spin");
      case "degraded":
        return new vscode.ThemeIcon("warning", new vscode.ThemeColor("list.warningForeground"));
      case "crashed":
        return new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed"));
      case "auth_required":
        return new vscode.ThemeIcon("key");
      case "not_configured":
        return new vscode.ThemeIcon("circle-outline");
      case "dependency_missing":
        return new vscode.ThemeIcon("cloud-download");
      case "blocked_by_policy":
        return new vscode.ThemeIcon("lock");
      case "version_mismatch":
        return new vscode.ThemeIcon("versions");
      case "unsafe_disabled":
        return new vscode.ThemeIcon("circle-slash");
    }
  }
}
