import * as vscode from "vscode";
import type { GatewayClient } from "../gateway/GatewayClient.js";
import type { ConnectionHealth } from "@mcp-proxy/shared";
import type { ConnectionId } from "@mcp-proxy/shared";

const POLL_INTERVAL_MS = 5_000;

/**
 * HealthMonitor polls the gateway control API and maintains an in-memory
 * snapshot of connection health, firing events when state changes.
 *
 * The tree view and MCP provider both subscribe to these events.
 */
export class HealthMonitor implements vscode.Disposable {
  private healthMap = new Map<ConnectionId, ConnectionHealth>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private client: GatewayClient;

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
    try {
      const status = await this.client.getStatus();
      for (const conn of status.connections) {
        const previous = this.healthMap.get(conn.id);
        this.healthMap.set(conn.id, conn.health);

        if (previous?.status !== conn.health.status) {
          this._onHealthChanged.fire({ id: conn.id, health: conn.health });
        }
      }
    } catch {
      // Gateway may not be ready yet; silently retry on next tick
    }
  }
}
