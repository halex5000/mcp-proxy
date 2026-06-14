import { EventEmitter } from "events";
import type { ActiveConnectionConfig, ConnectionId } from "@mcp-proxy/shared";
import { ManagedProcess } from "./ManagedProcess.js";
import type { ProcessEvent } from "./ManagedProcess.js";

/**
 * Supervisor manages the lifecycle of all downstream MCP server processes.
 *
 * The extension configures the supervisor via the control API. The supervisor
 * starts/stops/restarts each server process independently and surfaces health
 * events to the HealthAggregator.
 */
export class Supervisor extends EventEmitter {
  private processes = new Map<ConnectionId, ManagedProcess>();

  async configure(configs: ActiveConnectionConfig[]): Promise<void> {
    const incoming = new Set(configs.map((c) => c.id));

    // Remove connections that are no longer configured
    for (const [id, proc] of this.processes) {
      if (!incoming.has(id)) {
        await proc.stop();
        this.processes.delete(id);
      }
    }

    // Add or reconfigure
    for (const config of configs) {
      if (!config.enabled || config.definition.kind !== "local-stdio") continue;

      const existing = this.processes.get(config.id);
      if (existing) {
        // Config may have changed (e.g. new auth token); restart to pick it up
        await existing.restart();
        continue;
      }

      if (!config.definition.command) continue;

      const proc = new ManagedProcess({
        id: config.id,
        command: config.definition.command,
        args: config.definition.args ?? [],
        env: this.buildEnv(config),
        autoRestart: true,
      });

      proc.onEvent((event: ProcessEvent) => {
        this.emit("processEvent", event);
      });

      this.processes.set(config.id, proc);
      await proc.start();
    }
  }

  async restart(id: ConnectionId): Promise<void> {
    const proc = this.processes.get(id);
    if (!proc) throw new Error(`Unknown connection: ${id}`);
    await proc.restart();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.processes.values()].map((p) => p.stop()));
  }

  getProcess(id: ConnectionId): ManagedProcess | undefined {
    return this.processes.get(id);
  }

  getAllProcesses(): Map<ConnectionId, ManagedProcess> {
    return this.processes;
  }

  private buildEnv(config: ActiveConnectionConfig): Record<string, string> {
    const env: Record<string, string> = { ...config.settings };
    if (config.authToken) {
      // Convention: pass auth token as MCP_AUTH_TOKEN; each server definition
      // maps this to its own expected env var in the definition.
      env["MCP_AUTH_TOKEN"] = config.authToken;
    }
    return env;
  }
}
