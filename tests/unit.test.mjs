import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { ToolFilter } from "../packages/gateway/dist/proxy/ToolFilter.js";

const require = createRequire(import.meta.url);
const shared = require("../packages/shared/dist/index.js");

function definition(overrides = {}) {
  return {
    id: "test-echo",
    name: "Test Echo",
    description: "fixture",
    kind: "local-stdio",
    icon: "$(beaker)",
    requiredConfig: [],
    optionalConfig: [],
    safeByDefault: true,
    ...overrides,
  };
}

test("health model includes product-facing aliases and assistant summary", () => {
  const health = shared.makeDefaultHealth("ready", "test-echo", "managed");

  assert.equal(health.id, "test-echo");
  assert.equal(health.mode, "managed");
  assert.equal(health.state, "ready");
  assert.equal(health.status, "ready");
  assert.equal(health.userMessage, "Connected and working.");
  assert.equal(health.message, "Connected and working.");
  assert.equal(health.assistantSummary, "Connected and working.");
  assert.match(health.lastCheckedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(health.availableActions, health.actions);
});

test("tool filter hides unsafe tools by default before MCP tools/list", () => {
  const filter = new ToolFilter("test-echo", definition());
  const tools = filter.filter([
    { name: "echo" },
    { name: "shell_exec" },
    { name: "delete_files" },
    { name: "browser_run_code_unsafe" },
  ]);

  assert.equal(tools.find((tool) => tool.name === "echo")?.isVisible, true);

  for (const name of ["shell_exec", "delete_files", "browser_run_code_unsafe"]) {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.equal(tool?.isSafe, false);
    assert.equal(tool?.isVisible, false);
    assert.match(tool?.hiddenReason ?? "", /unsafe|code|files/i);
  }
});

test("tool filter keeps denylist and allowlist behavior explicit", () => {
  const filter = new ToolFilter(
    "test-echo",
    definition({
      allowlist: ["echo", "get_**"],
      denylist: ["get_secret"],
    })
  );

  const tools = filter.filter([
    { name: "echo" },
    { name: "get_fake_data" },
    { name: "get_secret" },
    { name: "unexpected_tool" },
  ]);

  assert.equal(tools.find((tool) => tool.name === "echo")?.isVisible, true);
  assert.equal(tools.find((tool) => tool.name === "get_fake_data")?.isVisible, true);
  assert.equal(tools.find((tool) => tool.name === "get_secret")?.isVisible, false);
  assert.equal(tools.find((tool) => tool.name === "unexpected_tool")?.isVisible, false);
});
