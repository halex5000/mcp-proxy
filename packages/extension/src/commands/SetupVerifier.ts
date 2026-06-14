import * as vscode from "vscode";
import { authHeader } from "@mcp-proxy/shared";
import type { GatewayClient } from "../gateway/GatewayClient.js";
import type { GatewayProcess } from "../gateway/GatewayProcess.js";
import type { GatewayStatusResponse, ToolEntry } from "@mcp-proxy/shared";

type CheckState = "pass" | "warn" | "fail";

export interface VerificationCheck {
  label: string;
  state: CheckState;
  detail: string;
}

const UNSAFE_TOOL_PATTERNS = [
  /shell_exec/i,
  /delete_files/i,
  /browser_run_code_unsafe/i,
  /execute_code/i,
  /run_command/i,
  /browser_execute_script/i,
];

export async function verifyLocalSetup(opts: {
  gatewayClient: GatewayClient;
  gatewayProcess: GatewayProcess;
  silent?: boolean;
}): Promise<{ checks: VerificationCheck[]; markdown: string }> {
  const checks: VerificationCheck[] = [];
  let status: GatewayStatusResponse | undefined;

  checks.push({
    label: "Extension activated",
    state: "pass",
    detail: "The Managed Connections command executed inside the active extension host.",
  });

  checks.push({
    label: "Gateway process running",
    state: opts.gatewayProcess.isRunning ? "pass" : "fail",
    detail: opts.gatewayProcess.isRunning
      ? "The extension-owned gateway process is running."
      : "The extension-owned gateway process is not running.",
  });

  checks.push({
    label: "Gateway port discovered",
    state: opts.gatewayProcess.port !== null ? "pass" : "fail",
    detail:
      opts.gatewayProcess.port !== null
        ? `Gateway port: ${opts.gatewayProcess.port}`
        : "No gateway port has been announced yet.",
  });

  try {
    status = await opts.gatewayClient.getStatus();
    checks.push({
      label: "/control/status responding",
      state: "pass",
      detail: `Gateway ${status.version} responded with ${status.connections.length} connections.`,
    });
  } catch (err) {
    checks.push({
      label: "/control/status responding",
      state: "fail",
      detail: String(err),
    });
  }

  checks.push(await checkMcpEndpoint(opts.gatewayProcess));

  if (status) {
    const testEcho = status.connections.find((connection) => connection.id === "test-echo");
    if (testEcho) {
      const visibleTools = testEcho.tools.filter((tool) => tool.isVisible);
      const hiddenUnsafeTools = testEcho.tools.filter(
        (tool) => !tool.isVisible && !tool.isSafe
      );
      const visibleUnsafeTools = visibleTools.filter(isUnsafeTool);

      checks.push({
        label: "Test Echo connected",
        state: testEcho.health.state === "ready" ? "pass" : "fail",
        detail: `State: ${testEcho.health.label}. ${testEcho.health.userMessage}`,
      });

      checks.push({
        label: "Tools exposed",
        state: visibleTools.length >= 3 ? "pass" : "warn",
        detail: `${visibleTools.length} visible tools: ${visibleTools
          .map((tool) => tool.publicName ?? tool.name)
          .join(", ")}`,
      });

      checks.push({
        label: "Unsafe tools hidden",
        state: visibleUnsafeTools.length === 0 ? "pass" : "fail",
        detail:
          visibleUnsafeTools.length === 0
            ? hiddenUnsafeTools.length > 0
              ? `${hiddenUnsafeTools.length} unsafe tools are hidden by policy.`
              : "No unsafe tools are currently exposed. Use Simulate Connection State -> unsafe_tools to demo hidden tools."
            : `Unsafe tools are visible: ${visibleUnsafeTools
                .map((tool) => tool.publicName ?? tool.name)
                .join(", ")}`,
      });
    } else {
      checks.push({
        label: "Test Echo connected",
        state: "fail",
        detail: "The test-echo connection is missing from /control/status.",
      });
    }

    const obviousFailures = status.connections.filter((connection) =>
      ["crashed", "degraded"].includes(connection.health.state)
    );
    checks.push({
      label: "Obvious failures",
      state: obviousFailures.length === 0 ? "pass" : "warn",
      detail:
        obviousFailures.length === 0
          ? "No crashed or degraded connections reported."
          : obviousFailures
              .map((connection) => `${connection.name}: ${connection.health.label}`)
              .join(", "),
    });
  }

  const markdown = renderVerificationMarkdown(checks, status);

  const failures = checks.filter((check) => check.state === "fail");
  const warnings = checks.filter((check) => check.state === "warn");

  if (!opts.silent) {
    const document = await vscode.workspace.openTextDocument({
      language: "markdown",
      content: markdown,
    });
    await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside);

    if (failures.length > 0) {
      await vscode.window.showErrorMessage(
        `Managed Connections setup has ${failures.length} failure(s). See the verification report.`
      );
    } else if (warnings.length > 0) {
      await vscode.window.showWarningMessage(
        `Managed Connections setup passed with ${warnings.length} warning(s).`
      );
    } else {
      await vscode.window.showInformationMessage(
        "Managed Connections local setup looks good."
      );
    }
  }

  return { checks, markdown };
}

async function checkMcpEndpoint(
  gatewayProcess: GatewayProcess
): Promise<VerificationCheck> {
  if (!gatewayProcess.mcpUri) {
    return {
      label: "MCP endpoint responding",
      state: "fail",
      detail: "No MCP URI is available because the gateway port is missing.",
    };
  }

  const controller = new AbortController();
  try {
    const response = await withTimeout(
      fetch(gatewayProcess.mcpUri, {
        method: "GET",
        headers: {
          ...authHeader(gatewayProcess.authToken),
          Accept: "application/json, text/event-stream",
        },
        signal: controller.signal,
      }),
      3_000,
      () => controller.abort()
    );

    const reachable = response.ok || response.status === 400;

    return {
      label: "MCP endpoint responding",
      state: reachable ? "pass" : "fail",
      detail: reachable
        ? `MCP route responded with HTTP ${response.status}.`
        : `MCP route returned HTTP ${response.status}.`,
    };
  } catch (err) {
    return {
      label: "MCP endpoint responding",
      state: String(err).includes("timed out") ? "warn" : "fail",
      detail: String(err),
    };
  } finally {
    controller.abort();
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            onTimeout();
            reject(new Error(`MCP route check timed out after ${timeoutMs}ms`));
          },
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function renderVerificationMarkdown(
  checks: VerificationCheck[],
  status: GatewayStatusResponse | undefined
): string {
  const rows = checks
    .map(
      (check) =>
        `| ${statusIcon(check.state)} | ${escapeMarkdown(check.label)} | ${escapeMarkdown(check.detail)} |`
    )
    .join("\n");

  const connectionRows =
    status?.connections
      .map(
        (connection) =>
          `| ${escapeMarkdown(connection.name)} | ${connection.health.state} | ${escapeMarkdown(
            connection.health.userMessage
          )} | ${connection.health.toolCount} | ${connection.health.hiddenToolCount} |`
      )
      .join("\n") ?? "| (unknown) | n/a | /control/status did not respond | n/a | n/a |";

  return `# Managed Connections Local Setup Verification

Run from: \`Managed Connections: Verify Local Setup\`

## Summary

| Result | Check | Detail |
|---|---|---|
${rows}

## Connections

| Connection | State | Message | Visible tools | Hidden tools |
|---|---|---|---:|---:|
${connectionRows}

## What This Proves

- The VS Code extension activated.
- The extension-owned gateway process started.
- The control plane is reachable.
- The MCP endpoint responds to initialize.
- The deterministic Test Echo connection is usable.
- Unsafe-looking tools are not exposed as visible tools.

Normal users should not need terminal commands, raw logs, ports, or \`mcp.json\` to complete this verification.
`;
}

function isUnsafeTool(tool: ToolEntry): boolean {
  const name = tool.publicName ?? tool.name;
  return UNSAFE_TOOL_PATTERNS.some((pattern) => pattern.test(name));
}

function statusIcon(state: CheckState): string {
  switch (state) {
    case "pass":
      return "Pass";
    case "warn":
      return "Warning";
    case "fail":
      return "Fail";
  }
}

function escapeMarkdown(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
