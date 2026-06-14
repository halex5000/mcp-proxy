#!/usr/bin/env node
/**
 * Gateway process entry point.
 *
 * Startup sequence:
 *   1. Start the HTTP control server on a random port
 *   2. Print GATEWAY_READY port=XXXX to stdout
 *   3. Start the MCP stdio server (VS Code connects here)
 *   4. Wait for the extension to POST /configure
 *   5. Spin up downstream server processes via the Supervisor
 *   6. Connect proxies to downstream servers
 *   7. Register proxied tools on the MCP server
 */

import { Supervisor } from "./supervisor/Supervisor.js";
import { ControlServer } from "./ControlServer.js";
import { GatewayServer } from "./GatewayServer.js";
import { HealthAggregator } from "./health/HealthAggregator.js";
import { McpProxy } from "./proxy/McpProxy.js";
import { formatGatewayReady } from "@mcp-proxy/shared";
import type { GatewayConfig, ConnectionId } from "@mcp-proxy/shared";

async function main(): Promise<void> {
  const supervisor = new Supervisor();
  const healthAggregator = new HealthAggregator();
  const controlServer = new ControlServer(supervisor, healthAggregator);
  const gatewayServer = new GatewayServer(healthAggregator, supervisor);

  const proxies = new Map<ConnectionId, McpProxy>();

  // Forward process events to health aggregator overrides
  supervisor.on("processEvent", (event) => {
    if (event.kind === "crashed") {
      healthAggregator.setOverride(event.connectionId, {
        status: "crashed",
      });
    } else if (event.kind === "started") {
      healthAggregator.clearOverride(event.connectionId);
    }
  });

  controlServer.setOnConfigure(async (config: GatewayConfig) => {
    await supervisor.configure(config.connections);

    // For each local-stdio connection, create a proxy once its process is running
    for (const connConfig of config.connections) {
      if (!connConfig.enabled) continue;
      if (connConfig.definition.kind !== "local-stdio") continue;

      const proc = supervisor.getProcess(connConfig.id);
      if (!proc) continue;

      // Wait for process to reach running state before connecting
      await waitForRunning(proc);

      if (!proxies.has(connConfig.id)) {
        const proxy = new McpProxy(connConfig.id, proc, connConfig.definition);
        try {
          await proxy.connect();
          proxies.set(connConfig.id, proxy);
          controlServer.updateProxy(connConfig.id, proxy);
          gatewayServer.registerProxy(connConfig.id, proxy);
        } catch (err) {
          process.stderr.write(
            `Failed to connect proxy for ${connConfig.id}: ${err}\n`
          );
        }
      }
    }
  });

  // Start control HTTP server
  const port = await controlServer.listen();

  // Announce port to the extension (must go to stderr to not pollute MCP stdio)
  process.stderr.write(formatGatewayReady(port) + "\n");

  // Also write to a dedicated fd if the extension sets GATEWAY_ANNOUNCE_FD
  const announceFd = process.env["GATEWAY_ANNOUNCE_FD"];
  if (announceFd) {
    const fd = parseInt(announceFd, 10);
    const announceStream = { write: (s: string) => process.stdout.write(s) };
    void announceStream;
    require("fs").writeSync(fd, formatGatewayReady(port) + "\n");
  }

  // Start MCP stdio server — this is the blocking call
  await gatewayServer.start();

  // Cleanup on exit
  process.on("SIGTERM", async () => {
    await supervisor.stopAll();
    await controlServer.close();
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await supervisor.stopAll();
    await controlServer.close();
    process.exit(0);
  });
}

function waitForRunning(
  proc: import("./supervisor/ManagedProcess.js").ManagedProcess,
  timeoutMs = 10_000
): Promise<void> {
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

main().catch((err) => {
  process.stderr.write(`Gateway fatal error: ${err}\n`);
  process.exit(1);
});
