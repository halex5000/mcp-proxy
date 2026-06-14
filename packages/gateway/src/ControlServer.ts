import type { Express, Request, Response, Router } from "express";
import express from "express";
import type { Supervisor } from "./supervisor/Supervisor.js";
import type { HealthAggregator } from "./health/HealthAggregator.js";
import type { McpProxy } from "./proxy/McpProxy.js";
import { CONTROL_PREFIX } from "@mcp-proxy/shared";
import type {
  GatewayStatusResponse,
  ConnectionsResponse,
  ConnectionHealthResponse,
  ConfigureRequest,
  ConfigureResponse,
  DiagnosticsResponse,
  RestartResponse,
  GatewayDiagnosticsResponse,
  LogsResponse,
  GatewayLogsResponse,
  SimulateRequest,
  SimulateResponse,
} from "@mcp-proxy/shared";
import type { ConnectionId, GatewayConfig } from "@mcp-proxy/shared";
import { HEALTH_MESSAGES, isSimulationMode, type SimulationMode } from "@mcp-proxy/shared";

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

  removeProxy(id: ConnectionId): void {
    this.proxies.delete(id);
  }

  getConnectionStatuses() {
    return this.buildConnectionStatuses();
  }

  async restartConnection(id: ConnectionId): Promise<RestartResponse> {
    const config = this.config?.connections.find((c) => c.id === id);
    if (config && this.isCrashSimulation(config.settings["FAKE_MCP_MODE"])) {
      config.settings["FAKE_MCP_MODE"] = "ready";
      config.autoRestart = true;
      delete config.healthOverride;
      await this.onConfigure?.(this.config!);
    } else {
      await this.supervisor.restart(id);
    }

    const health = this.buildConnectionStatuses().find((s) => s.id === id)?.health;
    return { ok: true, message: `Restarted ${id}`, health };
  }

  mount(app: Express): void {
    const router: Router = express.Router();
    router.get("/status", this.handleStatus.bind(this));
    router.get("/connections", this.handleConnections.bind(this));
    router.get("/connections/:id/health", this.handleConnectionHealth.bind(this));
    router.post("/configure", this.handleConfigure.bind(this));
    router.post("/connections/:id/restart", this.handleRestart.bind(this));
    router.post("/connections/:id/simulate", this.handleSimulate.bind(this));
    router.get("/diagnostics", this.handleGatewayDiagnostics.bind(this));
    router.get("/logs", this.handleGatewayLogs.bind(this));
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

  private handleConnections(_req: Request, res: Response): void {
    const response: ConnectionsResponse = {
      connections: this.buildConnectionStatuses(),
    };
    res.json(response);
  }

  private handleConnectionHealth(req: Request, res: Response): void {
    const id = req.params["id"] as ConnectionId;
    const entry = this.buildConnectionStatuses().find((status) => status.id === id);
    if (!entry) {
      res.status(404).json({ error: `Connection ${id} not found` });
      return;
    }
    const response: ConnectionHealthResponse = { id, health: entry.health };
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
      res.json(await this.restartConnection(id));
    } catch (err) {
      res.status(500).json({ ok: false, message: String(err) });
    }
  }

  private async handleSimulate(req: Request, res: Response): Promise<void> {
    const id = req.params["id"] as ConnectionId;
    const body = req.body as SimulateRequest;

    if (!isSimulationMode(body?.mode)) {
      res.status(400).json({ ok: false, error: "Invalid simulation mode" });
      return;
    }

    const config = this.config?.connections.find((c) => c.id === id);
    if (!this.config || !config) {
      res.status(404).json({ ok: false, error: `Connection ${id} not found` });
      return;
    }

    this.applySimulation(config, body.mode);

    try {
      await this.onConfigure?.(this.config);
      const health = this.buildConnectionStatuses().find((s) => s.id === id)?.health;
      const response: SimulateResponse = {
        ok: true,
        connectionId: id,
        mode: body.mode,
        message: `Simulation mode for ${id} set to ${body.mode}`,
        health,
      };
      res.json(response);
    } catch (err) {
      res.status(500).json({
        ok: false,
        connectionId: id,
        mode: body.mode,
        message: String(err),
      });
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

    const health = this.healthAggregator.computeWithConfig(
      id,
      config?.definition.name ?? id,
      config,
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

  private handleGatewayDiagnostics(_req: Request, res: Response): void {
    const statuses = this.buildConnectionStatuses();
    const response: GatewayDiagnosticsResponse = {
      version: "0.1.0",
      pid: process.pid,
      uptimeMs: Date.now() - this.startTime,
      connections: statuses.map((entry) => ({
        id: entry.id,
        name: entry.name,
        health: entry.health,
        diagnostics: entry.health.diagnostics,
      })),
    };
    res.json(response);
  }

  private handleGatewayLogs(_req: Request, res: Response): void {
    const lines = [...this.supervisor.getAllProcesses()].flatMap(([connectionId, proc]) =>
      proc.recentLogs.map((line) => ({ ...line, connectionId }))
    );
    const response: GatewayLogsResponse = { lines };
    res.json(response);
  }

  private buildConnectionStatuses() {
    const statuses = [];

    // Include all configured connections, even disabled ones, so the extension
    // can show healthOverride states (unsafe_disabled, dependency_missing).
    const allConfigs = this.config?.connections ?? [];
    const seenIds = new Set<ConnectionId>();

    for (const config of allConfigs) {
      seenIds.add(config.id);
      const proc = this.supervisor.getProcess(config.id);
      const proxy = this.proxies.get(config.id);
      const health = this.healthAggregator.computeWithConfig(
        config.id,
        config.definition.name,
        config,
        proc,
        proxy
      );
      statuses.push({
        id: config.id,
        name: config.definition.name,
        health,
        tools: proxy?.tools.map((t) => ({
          name: t.name,
          publicName: t.publicName,
          description: t.description ?? "",
          isVisible: t.isVisible,
          isSafe: t.isSafe,
          hiddenReason: t.hiddenReason,
        })) ?? [],
      });
    }

    // Also include any running processes not in current config (edge case on config reload)
    for (const [id, proc] of this.supervisor.getAllProcesses()) {
      if (seenIds.has(id)) continue;
      const proxy = this.proxies.get(id);
      const health = this.healthAggregator.compute(id, id, proc, proxy);
      statuses.push({
        id,
        name: id,
        health,
        tools: proxy?.tools.map((t) => ({
          name: t.name,
          publicName: t.publicName,
          description: t.description ?? "",
          isVisible: t.isVisible,
          isSafe: t.isSafe,
          hiddenReason: t.hiddenReason,
        })) ?? [],
      });
    }

    return statuses;
  }

  private applySimulation(
    config: GatewayConfig["connections"][number],
    mode: SimulationMode
  ): void {
    config.settings = { ...config.settings };
    config.definition = { ...config.definition, allowUnsafeTools: false };

    switch (mode) {
      case "auth_required":
      case "dependency_missing":
      case "version_mismatch":
      case "blocked_by_policy":
        config.enabled = false;
        config.autoRestart = false;
        config.settings["FAKE_MCP_MODE"] = mode;
        config.healthOverride = {
          status: mode,
          message: HEALTH_MESSAGES[mode],
          detail: `Simulated ${mode} state for test/demo coverage.`,
        };
        return;

      case "crash_after_delay":
      case "crash_on_start":
      case "bad_json":
      case "hang":
      case "crash_during_tool_call":
        config.enabled = true;
        config.autoRestart = false;
        config.settings["MCP_AUTO_RESTART"] = "0";
        config.settings["FAKE_MCP_MODE"] = mode;
        delete config.healthOverride;
        return;

      case "unsafe_tools":
      case "slow_start":
      case "ready":
        config.enabled = true;
        config.autoRestart = true;
        delete config.settings["MCP_AUTO_RESTART"];
        config.settings["FAKE_MCP_MODE"] = mode;
        delete config.healthOverride;
        return;
    }
  }

  private isCrashSimulation(mode: string | undefined): boolean {
    return (
      mode === "crash_after_delay" ||
      mode === "crash_on_start" ||
      mode === "crash_during_tool_call" ||
      mode === "bad_json" ||
      mode === "hang"
    );
  }
}
