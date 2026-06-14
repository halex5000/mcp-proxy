#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { isSimulationMode, type SimulationMode } from "@mcp-proxy/shared";

const DEFAULT_CRASH_DELAY_MS = 1500;
const DEFAULT_SLOW_START_MS = 1500;

function parseMode(): SimulationMode {
  const argMode = process.argv.find((arg) => arg.startsWith("--mode="))?.slice("--mode=".length);
  const mode = argMode ?? process.env["FAKE_MCP_MODE"] ?? "ready";
  return isSimulationMode(mode) ? mode : "ready";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function keepAlive(): void {
  setInterval(() => {
    // Intentionally empty. This keeps hang/auth/dependency simulations alive.
  }, 60_000);
}

async function main(): Promise<void> {
  const mode = parseMode();

  process.stderr.write(`fake-mcp-server mode=${mode}\n`);

  switch (mode) {
    case "crash_on_start":
      process.stderr.write("fake-mcp-server simulated crash on start\n");
      process.exit(42);

    case "bad_json":
      process.stdout.write("{ this is not valid json }\n");
      keepAlive();
      return;

    case "hang":
      process.stderr.write("fake-mcp-server hanging before MCP initialize\n");
      keepAlive();
      return;

    case "slow_start":
      await delay(Number(process.env["FAKE_MCP_SLOW_START_MS"] ?? DEFAULT_SLOW_START_MS));
      break;

    case "crash_after_delay":
      setTimeout(() => {
        process.stderr.write("fake-mcp-server simulated crash after delay\n");
        process.exit(43);
      }, Number(process.env["FAKE_MCP_CRASH_DELAY_MS"] ?? DEFAULT_CRASH_DELAY_MS));
      break;

    case "auth_required":
      process.stderr.write("fake-mcp-server simulated auth_required\n");
      break;

    case "dependency_missing":
      process.stderr.write("fake-mcp-server simulated dependency_missing\n");
      break;

    case "version_mismatch":
      process.stderr.write("fake-mcp-server simulated version_mismatch\n");
      break;

    case "blocked_by_policy":
      process.stderr.write("fake-mcp-server simulated blocked_by_policy\n");
      break;

    case "ready":
    case "unsafe_tools":
    case "crash_during_tool_call":
      break;
  }

  const server = new McpServer({
    name: "fake-mcp-server",
    version: mode === "version_mismatch" ? "999.0.0" : "0.1.0",
  });

  registerSafeTools(server, mode);

  if (mode === "unsafe_tools") {
    registerUnsafeTools(server);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function registerSafeTools(server: McpServer, mode: SimulationMode): void {
  server.tool(
    "echo",
    "Echoes the provided message for smoke tests.",
    {
      message: z.string().optional(),
    },
    async ({ message }) => {
      if (mode === "crash_during_tool_call") {
        process.stderr.write("fake-mcp-server simulated crash during tool call\n");
        process.exit(44);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              echoed: message ?? "",
              marker: "fake-mcp-server",
              mode,
            }),
          },
        ],
      };
    }
  );

  server.tool(
    "get_fake_data",
    "Returns deterministic fixture data for integration tests.",
    {},
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            items: [
              { id: "alpha", label: "Alpha fixture" },
              { id: "bravo", label: "Bravo fixture" },
            ],
          }),
        },
      ],
    })
  );

  server.tool(
    "get_connection_marker",
    "Returns a stable marker proving this is the fake downstream test connection.",
    {},
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            connection: "test-echo",
            marker: "managed-gateway-proof",
            mode,
          }),
        },
      ],
    })
  );
}

function registerUnsafeTools(server: McpServer): void {
  server.tool(
    "shell_exec",
    "UNSAFE TEST FIXTURE: simulates arbitrary shell execution.",
    { command: z.string().optional() },
    async ({ command }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            blockedByGatewayExpected: true,
            command: command ?? "",
          }),
        },
      ],
    })
  );

  server.tool(
    "delete_files",
    "UNSAFE TEST FIXTURE: simulates deleting files.",
    { path: z.string().optional() },
    async ({ path }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            blockedByGatewayExpected: true,
            path: path ?? "",
          }),
        },
      ],
    })
  );

  server.tool(
    "browser_run_code_unsafe",
    "UNSAFE TEST FIXTURE: simulates arbitrary browser code execution.",
    { code: z.string().optional() },
    async ({ code }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            blockedByGatewayExpected: true,
            code: code ?? "",
          }),
        },
      ],
    })
  );
}

main().catch((err) => {
  process.stderr.write(`fake-mcp-server fatal error: ${String(err)}\n`);
  process.exit(1);
});
