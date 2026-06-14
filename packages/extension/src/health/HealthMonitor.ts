import * as vscode from "vscode";
import type { GatewayClient } from "../gateway/GatewayClient.js";
import type { ConnectionHealth } from "@mcp-proxy/shared";
import type { ConnectionId } from "@mcp-proxy/shared";
import { RemoteHealthChecker } from "./RemoteHealthChecker.js";

const POLL_INTERVAL_MS = 5_000;

/**
 * HealthMonitor maintains a unified snapshot of every connection's health,
 * merging two sources:
 *
 *   1. Gateway control API (/control/status) — covers all local-stdio connections
 *      supervised by the gateway process (local-knowledge, atlassian, playwright).
 *
 *   2. RemoteHealthChecker — covers connections registered directly with VS Code
 *      (GitHub remote MCP) whose health the gateway cannot observe.
 *
 * The tree view and command palette consume this merged map via onHealthChanged.
 */
export class HealthMonitor implements vscode.Disposable {
  private healthMap = new Map<ConnectionId, ConnectionHealth>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private client: GatewayClient;
  private remoteChecker = new RemoteHealthChecker();

  private _onHealthChanged = new vscode.EventEmitter<{
    id: ConnectionId;
    health: ConnectionHealth;
  }>();
  readonly onHealthChanged = this._onHealthChanged.event;

  constructor(client: GatewayClient) {
    this.client = client;
  }

  start(): void {
    this.poll();
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getHealth(id: ConnectionId): ConnectionHealth | undefined {
    return this.healthMap.get(id);
  }

  getAllHealth(): Map<ConnectionId, ConnectionHealth> {
    return this.healthMap;
  }

  dispose(): void {
    this.stop();
    this._onHealthChanged.dispose();
  }

  private async poll(): Promise<void> {
    await Promise.allSettled([
      this.pollGateway(),
      this.pollRemote(),
    ]);
  }

  private async pollGateway(): Promise<void> {
    try {
      const status = await this.client.getStatus();
      for (const conn of status.connections) {
        this.update(conn.id, conn.health);
      }
    } catch {
      // Gateway may not be ready yet; silently retry on next tick.
    }
  }

  private async pollRemote(): Promise<void> {
    try {
      const githubHealth = await this.remoteChecker.checkGitHub();
      this.update("github", githubHealth);
    } catch {
      // Non-fatal; gateway health is the primary source.
    }
  }

  private update(id: ConnectionId, health: ConnectionHealth): void {
    const previous = this.healthMap.get(id);
    this.healthMap.set(id, health);
    if (previous?.status !== health.status) {
      this._onHealthChanged.fire({ id, health });
    }
  }
}
