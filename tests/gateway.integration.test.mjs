import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const gatewayPath = join(repoRoot, "packages/gateway/dist/index.js");
const fakeServerPath = join(repoRoot, "packages/fake-mcp-server/dist/index.js");

test("gateway boots, exposes control status, proxies fake echo, filters unsafe tools, and recovers", async (t) => {
  const gateway = await startGateway();
  t.after(async () => {
    await gateway.stop();
  });

  await gateway.configure(config("ready"));

  const status = await gateway.get("/status");
  assert.equal(status.connections.length, 1);
  assert.equal(status.connections[0].id, "test-echo");
  assert.equal(status.connections[0].health.state, "ready");

  const client = await connectMcp(gateway.mcpUrl, gateway.token);
  t.after(async () => {
    await client.close();
  });

  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  assert.ok(names.includes("connections_status"));
  assert.ok(names.includes("connection_health"));
  assert.ok(names.includes("connection_diagnostics"));
  assert.ok(names.includes("restart_connection"));
  assert.ok(names.includes("test-echo__echo"));

  const echo = await client.callTool({
    name: "test-echo__echo",
    arguments: { input: { message: "smoke-pulse" } },
  });
  assert.match(JSON.stringify(echo), /smoke-pulse/);

  await gateway.post("/connections/test-echo/simulate", { mode: "unsafe_tools" });

  const unsafeStatus = await gateway.get("/status");
  const unsafeToolRows = unsafeStatus.connections[0].tools;
  assert.ok(unsafeToolRows.some((tool) => tool.name === "shell_exec" && tool.isVisible === false));
  assert.ok(unsafeStatus.connections[0].health.hiddenToolCount >= 3);

  const unsafeClient = await connectMcp(gateway.mcpUrl, gateway.token);
  t.after(async () => {
    await unsafeClient.close();
  });
  const unsafeListed = await unsafeClient.listTools();
  const unsafeNames = unsafeListed.tools.map((tool) => tool.name);
  assert.ok(!unsafeNames.includes("test-echo__shell_exec"));
  assert.ok(!unsafeNames.includes("test-echo__delete_files"));
  assert.ok(!unsafeNames.includes("test-echo__browser_run_code_unsafe"));
  const blockedUnsafeCall = await unsafeClient.callTool({
    name: "test-echo__shell_exec",
    arguments: { input: { command: "echo no" } },
  });
  assert.equal(blockedUnsafeCall.isError, true);
  assert.match(JSON.stringify(blockedUnsafeCall), /not found|Unknown tool/i);

  await gateway.post("/connections/test-echo/simulate", { mode: "crash_after_delay" });
  await waitFor(async () => {
    const crashed = await gateway.get("/connections/test-echo/health");
    assert.equal(crashed.health.state, "crashed");
  }, 5_000);

  const restart = await gateway.post("/connections/test-echo/restart", {});
  assert.equal(restart.ok, true);

  await waitFor(async () => {
    const recovered = await gateway.get("/connections/test-echo/health");
    assert.equal(recovered.health.state, "ready");
  }, 5_000);

  const recoveredClient = await connectMcp(gateway.mcpUrl, gateway.token);
  t.after(async () => {
    await recoveredClient.close();
  });
  const recoveredEcho = await recoveredClient.callTool({
    name: "test-echo__echo",
    arguments: { input: { message: "after-restart" } },
  });
  assert.match(JSON.stringify(recoveredEcho), /after-restart/);
});

function config(mode) {
  return {
    gatewayVersion: "0.1.0-test",
    connections: [
      {
        id: "test-echo",
        enabled: true,
        autoRestart: true,
        settings: { FAKE_MCP_MODE: mode },
        definition: {
          id: "test-echo",
          name: "Test Echo",
          description: "Deterministic downstream MCP fixture.",
          kind: "local-stdio",
          icon: "$(beaker)",
          requiredConfig: [],
          optionalConfig: [],
          safeByDefault: true,
          mode: "managed",
          command: process.execPath,
          args: [fakeServerPath],
        },
      },
    ],
  };
}

async function connectMcp(url, token) {
  const client = new Client(
    { name: "gateway-integration-test", version: "0.1.0" },
    { capabilities: {} }
  );
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: { Authorization: `Bearer ${token}` },
    },
  });
  await client.connect(transport);
  return client;
}

async function startGateway() {
  const token = randomBytes(16).toString("hex");
  const child = spawn(process.execPath, [gatewayPath], {
    cwd: repoRoot,
    env: { ...process.env, GATEWAY_AUTH_TOKEN: token },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  const port = await new Promise((resolvePort, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Gateway did not become ready. stderr:\n${stderr}`));
    }, 10_000);

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      const match = stderr.match(/GATEWAY_READY port=(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolvePort(Number(match[1]));
      }
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Gateway exited before ready with code ${code}. stderr:\n${stderr}`));
    });
  });

  const baseUrl = `http://127.0.0.1:${port}/control`;
  return {
    token,
    port,
    mcpUrl: `http://127.0.0.1:${port}/mcp`,
    async get(path) {
      const response = await fetch(baseUrl + path, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
      }
      return response.json();
    },
    async post(path, body) {
      const response = await fetch(baseUrl + path, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
      }
      return response.json();
    },
    async configure(body) {
      return this.post("/configure", body);
    },
    async stop() {
      if (!child.killed) {
        child.stdin.end();
        child.kill("SIGTERM");
      }
      await new Promise((resolveStop) => child.once("exit", resolveStop));
    },
  };
}

async function waitFor(assertion, timeoutMs) {
  const start = Date.now();
  let lastError;

  while (Date.now() - start < timeoutMs) {
    try {
      await assertion();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    }
  }

  throw lastError;
}
