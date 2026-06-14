import express, { type Request, type Response } from "express";
import * as http from "http";
import type { Supervisor } from "./supervisor/Supervisor.js";
import type { HealthAggregator } from "./health/HealthAggregator.js";
import type { McpProxy } from "./proxy/McpProxy.js";
import type {
  GatewayStatusResponse,
  ConfigureRequest,
  ConfigureResponse,
  DiagnosticsResponse,
  LogsResponse,
} from "@mcp-proxy/shared";
import type { ConnectionId, GatewayConfig } from "@mcp-proxy/shared";

/**
 * ControlServer is the HTTP control plane the VS Code extension uses to:
 *   - Poll connection health
 *   - Trigger restarts
 *   - Read diagnostic logs
 *   - Reconfigure the gateway (new auth tokens, enabled/disabled connections)
 *
 * It listens on a random port announced to the extension via stdout.
 * Only localhost connections are accepted.
 */
export class ControlServer {
  private app = express();
  private server: http.Server | null = null;
  private supervisor: Supervisor;
  private healthAggregator: HealthAggregator;
  private proxies = new Map<ConnectionId, McpProxy>();
  private config: GatewayConfig | null = null;
  private onConfigure: ((config: GatewayConfig) => Promise<void>) | null = null;
  private startTime = Date.now();

  constructor(supervisor: Supervisor, healthAggregator: HealthAggregator) {
    this.supervisor = supervisor;
    this.healthAggregator = healthAggregator;
    this.setupRoutes();
  }

  setOnConfigure(handler: (config: GatewayConfig) => Promise<void>): void {
    this.onConfigure = handler;
  }

  updateProxy(id: ConnectionId, proxy: McpProxy): void {
    this.proxies.set(id, proxy);
  }

  async listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(this.app);
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server!.address();
        if (!addr || typeof addr === "string") {
          reject(new Error("Failed to get server address"));
          return;
        }
        resolve(addr.port);
      });
    });
  }

  async close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
  }

  private setupRoutes(): void {
    this.app.use(express.json());

    // Reject non-localhost requests
    this.app.use((req: Request, res: Response, next) => {
      const ip = req.socket.remoteAddress;
      if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1") {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      next();
    });

    this.app.get("/status", this.handleStatus.bind(this));
    this.app.post("/configure", this.handleConfigure.bind(this));
    this.app.post("/connections/:id/restart", this.handleRestart.bind(this));
    this.app.get("/connections/:id/logs", this.handleLogs.bind(this));
    this.app.get("/connections/:id/diagnostics", this.handleDiagnostics.bind(this));
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
