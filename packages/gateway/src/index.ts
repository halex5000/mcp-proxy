#!/usr/bin/env node
/**
 * Gateway process entry point.
 *
 * ONE process, ONE port, TWO endpoints:
 *   POST/GET/DELETE /mcp        → MCP Streamable HTTP transport (VS Code client)
 *   *               /control/*  → control API (the owning extension)
 *
 * The extension spawns this process, passes a bearer token via GATEWAY_AUTH_TOKEN,
 * reads the announced port from stderr, then (a) registers /mcp with VS Code via
 * McpHttpServerDefinition and (b) drives /control/* itself. Because VS Code is an
 * HTTP client (not the spawner), the extension owns and monitors the exact
 * process Copilot uses.
 *
 * Startup sequence:
 *   1. Build supervisor, health aggregator, gateway server (MCP factory)
 *   2. Create one Express app; apply localhost guard + bearer auth
 *   3. Mount /control routes and the /mcp transport
 *   4. Listen on a random localhost port
 *   5. Print GATEWAY_READY port=XXXX to stderr
 *   6. On /control/configure: start downstream servers, connect proxies,
 *      and make their tools available to the next MCP session
 */

import express from "express";
import type { Request, Response, NextFunction } from "express";
import * as http from "node:http";
import { Supervisor } from "./supervisor/Supervisor.js";
import { ControlServer } from "./ControlServer.js";
import { GatewayServer } from "./GatewayServer.js";
import { McpHttpEndpoint } from "./McpHttpEndpoint.js";
import { HealthAggregator } from "./health/HealthAggregator.js";
import { McpProxy } from "./proxy/McpProxy.js";
import { AUTH_TOKEN_ENV, formatGatewayReady, MCP_PATH } from "@mcp-proxy/shared";
import type { GatewayConfig, ConnectionId } from "@mcp-proxy/shared";
import type { ManagedProcess } from "./supervisor/ManagedProcess.js";

async function main(): Promise<void> {
  const supervisor = new Supervisor();
  const healthAggregator = new HealthAggregator();
  const gatewayServer = new GatewayServer(healthAggregator, supervisor);
  const controlServer = new ControlServer(supervisor, healthAggregator);
  const mcpEndpoint = new McpHttpEndpoint(gatewayServer);

  const proxies = new Map<ConnectionId, McpProxy>();
  const authToken = process.env[AUTH_TOKEN_ENV];
  let configuring = false;

  gatewayServer.setStatusProvider(() => controlServer.getConnectionStatuses());
  gatewayServer.setRestartHandler((id) => controlServer.restartConnection(id));

  supervisor.on("processEvent", (event) => {
    if (event.kind === "crashed") {
      healthAggregator.setOverride(event.connectionId, { status: "crashed" });
    } else if (event.kind === "started") {
      healthAggregator.clearOverride(event.connectionId);
      if (configuring) return;
      const proxy = proxies.get(event.connectionId);
      if (proxy) {
        reconnectProxy(event.connectionId, proxy).catch((err) => {
          healthAggregator.setOverride(event.connectionId, {
            status: "degraded",
            message: "Connected, but some features may not be available.",
            detail: String(err),
          });
          process.stderr.write(
            `Failed to reconnect proxy for ${event.connectionId}: ${err}\n`
          );
        });
      }
    }
  });

  controlServer.setOnConfigure(async (config: GatewayConfig) => {
    configuring = true;
    try {
      await supervisor.configure(config.connections);
    } finally {
      configuring = false;
    }

    const activeLocalIds = new Set(
      config.connections
        .filter((conn) => conn.enabled && conn.definition.kind === "local-stdio")
        .map((conn) => conn.id)
    );

    for (const id of [...proxies.keys()]) {
      if (!activeLocalIds.has(id)) {
        const proxy = proxies.get(id);
        await proxy?.disconnect();
        proxies.delete(id);
        controlServer.removeProxy(id);
        gatewayServer.removeProxy(id);
      }
    }

    for (const connConfig of config.connections) {
      if (!connConfig.enabled) continue;
      if (connConfig.definition.kind !== "local-stdio") continue;

      const proc = supervisor.getProcess(connConfig.id);
      if (!proc) continue;

      await waitForRunning(proc);

      let proxy = proxies.get(connConfig.id);
      if (!proxy) {
        proxy = new McpProxy(connConfig.id, proc, connConfig.definition);
        proxies.set(connConfig.id, proxy);
        controlServer.updateProxy(connConfig.id, proxy);
        gatewayServer.registerProxy(connConfig.id, proxy);
      }

      try {
        await proxy.reconnect();
        healthAggregator.clearOverride(connConfig.id);
      } catch (err) {
        healthAggregator.setOverride(connConfig.id, {
          status: "degraded",
          message: "Connected, but some features may not be available.",
          detail: String(err),
        });
        process.stderr.write(
          `Failed to connect proxy for ${connConfig.id}: ${err}\n`
        );
      }
    }
  });

  // ── Single multiplexed HTTP server ────────────────────────────────────────
  const app = express();
  app.use(express.json());

  // Reject anything that isn't loopback.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const ip = req.socket.remoteAddress;
    if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  });

  // Require the shared bearer token (set by the extension). Skipped only if the
  // extension didn't provide one (dev/standalone runs).
  if (authToken) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      const header = req.headers["authorization"];
      if (header !== `Bearer ${authToken}`) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      next();
    });
  }

  controlServer.mount(app);
  mcpEndpoint.mount(app);

  const server = http.createServer(app);
  const port = await listen(server);

  // Announce the port to the extension on stderr (stdout stays clean).
  process.stderr.write(formatGatewayReady(port) + "\n");
  process.stderr.write(`MCP endpoint: http://127.0.0.1:${port}${MCP_PATH}\n`);

  const shutdown = async () => {
    await mcpEndpoint.closeAll();
    await supervisor.stopAll();
    server.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // When stdin closes (extension deactivated / VS Code exiting), shut down too.
  process.stdin.on("close", shutdown);
  process.stdin.resume();
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to get server address"));
        return;
      }
      resolve(addr.port);
    });
  });
}

function waitForRunning(proc: ManagedProcess, timeoutMs = 10_000): Promise<void> {
  if (proc.state === "running") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Process ${proc.id} did not start within ${timeoutMs}ms`)),
      timeoutMs
    );
    const cleanup = proc.onEvent((event) => {
      if (event.connectionId === proc.id && event.kind === "started") {
        clearTimeout(timer);
        cleanup();
        resolve();
      } else if (event.connectionId === proc.id && event.kind === "crashed") {
        clearTimeout(timer);
        cleanup();
        reject(new Error(`Process ${proc.id} crashed during startup`));
      }
    });
  });
}

async function reconnectProxy(id: ConnectionId, proxy: McpProxy): Promise<void> {
  await proxy.reconnect();
  process.stderr.write(`Reconnected proxy for ${id}\n`);
}

main().catch((err) => {
  process.stderr.write(`Gateway fatal error: ${err}\n`);
  process.exit(1);
});
