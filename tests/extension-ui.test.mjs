import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const extensionManifest = require("../packages/extension/package.json");
const shared = require("../packages/shared/dist/index.js");
const {
  presentConnection,
  presentConnectionInfoItems,
} = require("../packages/extension/dist/providers/ConnectionPresentation.js");
const {
  isAuthCapable,
  nextEnabledConnections,
  SIMULATION_PICKER_MODES,
  simulationDescription,
} = require("../packages/extension/dist/commands/CommandRules.js");
const {
  CONNECTION_REGISTRY,
} = require("../packages/extension/dist/connections/ConnectionRegistry.js");

const EXPECTED_STATES = {
  ready: { iconId: "check", primaryAction: undefined, label: "Connected" },
  starting: { iconId: "loading~spin", primaryAction: undefined, label: "Starting…" },
  auth_required: { iconId: "key", primaryAction: "sign-in", label: "Needs sign-in" },
  crashed: { iconId: "error", primaryAction: "restart", label: "Crashed" },
  degraded: { iconId: "warning", primaryAction: "restart", label: "Partial" },
  blocked_by_policy: { iconId: "lock", primaryAction: "contact-admin", label: "Blocked" },
  version_mismatch: { iconId: "versions", primaryAction: "update-extension", label: "Update required" },
  unsafe_disabled: { iconId: "circle-slash", primaryAction: "enable", label: "Disabled (safe mode)" },
  dependency_missing: { iconId: "cloud-download", primaryAction: "install-dependency", label: "Setup needed" },
  not_configured: { iconId: "circle-outline", primaryAction: "open-settings", label: "Not set up" },
};

const RAW_DETAIL_PATTERNS = [
  /json-rpc/i,
  /\bstdio\b/i,
  /mcp-session-id/i,
  /module_not_found/i,
  /cannot find module/i,
  /stack trace/i,
  /gobbledegook/i,
  /mcp\.json/i,
  /GATEWAY_READY/i,
];

test("extension manifest uses a real Connections Activity Bar icon", () => {
  const container = extensionManifest.contributes.viewsContainers.activitybar.find(
    (entry) => entry.id === "managedConnections"
  );
  assert.equal(container.title, "Connections");
  assert.equal(container.icon, "resources/connections.svg");
  assert.equal(
    existsSync(resolve("packages/extension", container.icon)),
    true,
    `${container.icon} should exist`
  );
});

test("connection presentation covers every required UI state", () => {
  for (const [status, expected] of Object.entries(EXPECTED_STATES)) {
    const health = healthFor(status, {
      detail:
        "JSON-RPC stdio MODULE_NOT_FOUND Cannot find module /tmp/raw MCP detail",
      technicalMessage:
        "GATEWAY_READY port=1234; mcp-session-id abc; edit mcp.json",
    });

    const presentation = presentConnection(health);

    assert.equal(presentation.status, status);
    assert.equal(presentation.description, expected.label);
    assert.equal(presentation.iconId, expected.iconId);
    assert.equal(presentation.primaryAction, expected.primaryAction);
    assert.equal(presentation.secondaryAction, "open-diagnostics");
    assert.equal(presentation.contextValue, `connection-${status}`);
    assert.ok(presentation.userMessage.length > 0);

    for (const pattern of RAW_DETAIL_PATTERNS) {
      assert.doesNotMatch(
        presentation.tooltipMarkdown,
        pattern,
        `${status} leaked raw detail into normal UI`
      );
    }
  }
});

test("ready presentation shows available and hidden tools in friendly words", () => {
  const health = healthFor("ready", {
    toolCount: 3,
    hiddenToolCount: 2,
    hiddenTools: [
      {
        name: "test-echo__shell_exec",
        reason: "Hidden because it can run code.",
        isSafe: false,
      },
    ],
  });

  const presentation = presentConnection(health);
  const infoItems = presentConnectionInfoItems(health);

  assert.match(presentation.tooltipMarkdown, /3 tools available/);
  assert.match(presentation.tooltipMarkdown, /2 advanced tools hidden for safety/);
  assert.deepEqual(infoItems, [
    { label: "3 tools available", iconId: "tools" },
    { label: "2 advanced tools hidden", iconId: "shield" },
  ]);
});

test("command rules toggle enabled connections deterministically", () => {
  assert.deepEqual(
    nextEnabledConnections(["github"], "test-echo", true),
    ["github", "test-echo"]
  );
  assert.deepEqual(
    nextEnabledConnections(["github", "test-echo"], "test-echo", true),
    ["github", "test-echo"]
  );
  assert.deepEqual(
    nextEnabledConnections(["github", "test-echo", "test-echo"], "test-echo", false),
    ["github"]
  );
});

test("every simulation mode has a picker description", () => {
  for (const mode of shared.SIMULATION_MODES) {
    assert.ok(simulationDescription(mode).length > 0, mode);
  }
});

test("simulation picker exposes the demo-friendly modes", () => {
  assert.deepEqual(SIMULATION_PICKER_MODES, [
    "ready",
    "crash_after_delay",
    "auth_required",
    "dependency_missing",
    "version_mismatch",
    "unsafe_tools",
  ]);
});

test("sign-in picker only includes auth-capable connections", () => {
  const authCapableIds = CONNECTION_REGISTRY.filter(isAuthCapable).map((c) => c.id);

  // GitHub (OAuth) and Atlassian (secret token) genuinely support sign-in.
  assert.ok(authCapableIds.includes("github"), "github should be auth-capable");
  assert.ok(authCapableIds.includes("atlassian"), "atlassian should be auth-capable");

  // Test Echo, Project Knowledge, and Browser Automation have no auth surface
  // and must never appear in a Sign In picker.
  assert.equal(authCapableIds.includes("test-echo"), false);
  assert.equal(authCapableIds.includes("local-knowledge"), false);
  assert.equal(authCapableIds.includes("playwright"), false);
});

function healthFor(status, overrides = {}) {
  return {
    ...shared.makeDefaultHealth(status, "test-echo", "managed"),
    ...overrides,
    status,
    state: status,
    label: shared.HEALTH_LABELS[status],
    userMessage: shared.HEALTH_MESSAGES[status],
    message: shared.HEALTH_MESSAGES[status],
  };
}
