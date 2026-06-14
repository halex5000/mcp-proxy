import type { Express, Request, Response, Router } from "express";
import express from "express";
import type { Supervisor } from "./supervisor/Supervisor.js";
import type { HealthAggregator } from "./health/HealthAggregator.js";
import type { McpProxy } from "./proxy/McpProxy.js";
import { CONTROL_PREFIX } from "@mcp-proxy/shared";
import type {
  GatewayStatusResponse,
  ConfigureRequest,
  ConfigureResponse,
  DiagnosticsResponse,
  LogsResponse,
} from "@mcp-proxy/shared";
import type { ConnectionId, GatewayConfig } from "@mcp-proxy/shared";

/**
 * ControlServer mounts the extension-facing control plane on the shared Express
 * app under CONTROL_PREFIX (/control). The extension uses it to:
 *   - Poll connection health   (GET  /control/status)
 *   - Reconfigure the gateway  (POST /control/configure)
 *   - Restart a connection     (POST /control/connections/:id/restart)
 *   - Read logs / diagnostics  (GET  /control/connections/:id/logs|diagnostics)
 *
 * It no longer owns its own HTTP server — index.ts runs a single multiplexed
 * server that hosts both this control plane and the /mcp transport, so there is
 * exactly one process and one port. Auth (bearer token) and the localhost guard
 * are applied app-wide in index.ts.
 */
export class ControlServer {
  private supervisor: Supervisor;
  private healthAggregator: HealthAggregator;
  private proxies = new Map<ConnectionId, McpProxy>();
  private config: GatewayConfig | null = null;
  private onConfigure: ((config: GatewayConfig) => Promise<void>) | null = null;
  private startTime = Date.now();

  constructor(supervisor: Supervisor, healthAggregator: HealthAggregator) {
    this.supervisor = supervisor;
    this.healthAggregator = healthAggregator;
  }

  setOnConfigure(handler: (config: GatewayConfig) => Promise<void>): void {
    this.onConfigure = handler;
  }

  updateProxy(id: ConnectionId, proxy: McpProxy): void {
    this.proxies.set(id, proxy);
  }

  mount(app: Express): void {
    const router: Router = express.Router();
    router.get("/status", this.handleStatus.bind(this));
    router.post("/configure", this.handleConfigure.bind(this));
    router.post("/connections/:id/restart", this.handleRestart.bind(this));
    router.get("/connections/:id/logs", this.handleLogs.bind(this));
    router.get("/connections/:id/diagnostics", this.handleDiagnostics.bind(this));
    app.use(CONTROL_PREFIX, router);
  }

  private handleStatus(_req: Request, res: Response): void {
    const connections = this.buildConnectionStatuses();
    const response: GatewayStatusResponse = {
      version: "0.1.0",
      pid: process.pid,
      uptimeMs: Date.now() - this.startTime,
      connections,
    };
    res.json(response);
  }

  private async handleConfigure(req: Request, res: Response): Promise<void> {
    try {
      const config = req.body as ConfigureRequest;
      this.config = config;
      await this.onConfigure?.(config);
      const response: ConfigureResponse = { ok: true, errors: [] };
      res.json(response);
    } catch (err) {
      const response: ConfigureResponse = {
        ok: false,
        errors: [String(err)],
      };
      res.status(500).json(response);
    }
  }

  private async handleRestart(req: Request, res: Response): Promise<void> {
    const id = req.params["id"] as ConnectionId;
    try {
      await this.supervisor.restart(id);
      res.json({ ok: true, message: `Restarted ${id}` });
    } catch (err) {
      res.status(500).json({ ok: false, message: String(err) });
    }
  }

  private handleLogs(req: Request, res: Response): void {
    const id = req.params["id"] as ConnectionId;
    const proc = this.supervisor.getProcess(id);
    if (!proc) {
      res.status(404).json({ error: `Connection ${id} not found` });
      return;
    }
    const response: LogsResponse = {
      connectionId: id,
      lines: proc.recentLogs,
    };
    res.json(response);
  }

  private handleDiagnostics(req: Request, res: Response): void {
    const id = req.params["id"] as ConnectionId;
    const proc = this.supervisor.getProcess(id);
    const proxy = this.proxies.get(id);
    const config = this.config?.connections.find((c) => c.id === id);

    const health = this.healthAggregator.compute(
      id,
      config?.definition.name ?? id,
      proc,
      proxy
    );

    if (!health.diagnostics) {
      res.status(404).json({ error: "No diagnostics available" });
      return;
    }

    const response: DiagnosticsResponse = health.diagnostics;
    res.json(response);
  }

  private buildConnectionStatuses() {
    const statuses = [];
    for (const [id, proc] of this.supervisor.getAllProcesses()) {
      const proxy = this.proxies.get(id);
      const config = this.config?.connections.find((c) => c.id === id);
      const health = this.healthAggregator.compute(
        id,
        config?.definition.name ?? id,
        proc,
        proxy
      );
      statuses.push({
        id,
        name: config?.definition.name ?? id,
        health,
        tools: proxy?.tools.map((t) => ({
          name: t.name,
          description: t.description ?? "",
          isVisible: t.isVisible,
          isSafe: t.isSafe,
        })) ?? [],
      });
    }
    return statuses;
  }
}
