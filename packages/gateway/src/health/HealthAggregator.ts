import type { ConnectionHealth, ConnectionHealthStatus } from "@mcp-proxy/shared";
import {
  actionsForStatus,
  HEALTH_LABELS,
  HEALTH_MESSAGES,
  makeDefaultHealth,
} from "@mcp-proxy/shared";
import type { ManagedProcess, ProcessState } from "../supervisor/ManagedProcess.js";
import type { McpProxy } from "../proxy/McpProxy.js";
import type { ConnectionId, ActiveConnectionConfig } from "@mcp-proxy/shared";

/**
 * HealthAggregator builds ConnectionHealth snapshots by combining:
 * - Process state from the supervisor
 * - Tool availability from the MCP proxy
 * - Crash history and log tail
 *
 * The resulting health snapshot is what the extension reads from the control
 * API and what the Connections view displays.
 */
export class HealthAggregator {
  private overrides = new Map<ConnectionId, Partial<ConnectionHealth>>();

  setOverride(id: ConnectionId, override: Partial<ConnectionHealth>): void {
    this.overrides.set(id, override);
  }

  clearOverride(id: ConnectionId): void {
    this.overrides.delete(id);
  }

  /**
   * Compute health from process + proxy state, then apply any override the
   * extension set via the config (e.g. unsafe_disabled, dependency_missing).
   * The override short-circuits process-derived state entirely.
   */
  computeWithConfig(
    id: ConnectionId,
    name: string,
    config: ActiveConnectionConfig | undefined,
    process: ManagedProcess | undefined,
    proxy: McpProxy | undefined
  ): ConnectionHealth {
    if (config?.healthOverride) {
      const override = config.healthOverride;
      const mode = this.modeForConfig(config);
      const base = makeDefaultHealth(override.status, id, mode);
      const message = override.message ?? HEALTH_MESSAGES[override.status];
      return {
        ...base,
        status: override.status,
        state: override.status,
        label: HEALTH_LABELS[override.status],
        userMessage: message,
        message,
        assistantSummary:
          override.detail
            ? `${message} Detail: ${override.detail}`
            : message,
        technicalMessage: override.detail,
        detail: override.detail,
        lastChecked: base.lastChecked,
        lastCheckedAt: base.lastCheckedAt,
        restartCount: 0,
        crashCount: 0,
        toolCount: 0,
        hiddenToolCount: 0,
        hiddenTools: [],
        availableActions: actionsForStatus(override.status),
        actions: actionsForStatus(override.status),
        diagnostics: {
          connectionId: id,
          crashCount: 0,
          recentLogs: [],
          environment: {},
          toolCount: 0,
          hiddenToolCount: 0,
          assistantSummary:
            override.detail
              ? `${override.message} Detail: ${override.detail}`
              : (override.message ?? HEALTH_MESSAGES[override.status]),
        },
      };
    }
    return this.compute(id, name, process, proxy);
  }

  compute(
    id: ConnectionId,
    name: string,
    process: ManagedProcess | undefined,
    proxy: McpProxy | undefined
  ): ConnectionHealth {
    const status = this.deriveStatus(process, proxy);
    const base = makeDefaultHealth(status, id);

    const recentLogs = process?.recentLogs ?? [];
    const lastError = this.findLastError(process);
    const toolCount = proxy?.tools.filter((t) => t.isVisible).length ?? 0;
    const hiddenToolCount = proxy?.tools.filter((t) => !t.isVisible).length ?? 0;
    const hiddenTools =
      proxy?.tools
        .filter((t) => !t.isVisible)
        .map((t) => ({
          name: t.publicName,
          reason: t.hiddenReason ?? "Hidden by safety policy.",
          isSafe: t.isSafe,
        })) ?? [];
    const assistantSummary = this.buildAssistantSummary(
      id,
      name,
      status,
      lastError,
      toolCount,
      hiddenToolCount
    );
    const now = Date.now();

    const health: ConnectionHealth = {
      ...base,
      status,
      state: status,
      label: HEALTH_LABELS[status],
      userMessage: HEALTH_MESSAGES[status],
      message: HEALTH_MESSAGES[status],
      assistantSummary,
      technicalMessage: lastError,
      lastChecked: now,
      lastCheckedAt: new Date(now).toISOString(),
      startedAt: process?.state === "running" ? Date.now() - (process.uptime ?? 0) : undefined,
      uptimeMs: process?.uptime,
      restartCount: process?.crashes ?? 0,
      crashCount: process?.crashes ?? 0,
      nextRetryAt: process?.nextRetryAt,
      toolCount,
      hiddenToolCount,
      hiddenTools,
      availableActions: actionsForStatus(status),
      actions: actionsForStatus(status),
      diagnostics: {
        connectionId: id,
        lastError,
        crashCount: process?.crashes ?? 0,
        recentLogs: recentLogs
          .slice(-50)
          .reverse()
          .map((l) => `[${l.level}] ${l.text}`),
        environment: {},
        toolCount,
        hiddenToolCount,
        assistantSummary,
      },
    };

    const override = this.overrides.get(id);
    if (!override) return health;

    const overrideStatus = override.status ?? health.status;
    const overrideMessage = override.message ?? HEALTH_MESSAGES[overrideStatus];
    return {
      ...health,
      ...override,
      status: overrideStatus,
      state: overrideStatus,
      label: HEALTH_LABELS[overrideStatus],
      userMessage: overrideMessage,
      message: overrideMessage,
      assistantSummary:
        override.detail
          ? `${overrideMessage} Detail: ${override.detail}`
          : overrideMessage,
      technicalMessage: override.detail ?? health.technicalMessage,
      detail: override.detail ?? health.detail,
      availableActions: actionsForStatus(overrideStatus),
      actions: actionsForStatus(overrideStatus),
    };
  }

  private deriveStatus(
    proc: ManagedProcess | undefined,
    proxy: McpProxy | undefined
  ): ConnectionHealthStatus {
    if (!proc) return "not_configured";

    switch (proc.state as ProcessState) {
      case "idle":
        return "not_configured";
      case "starting":
        return "starting";
      case "stopping":
        return "stopping";
      case "stopped":
        return "not_configured";
      case "crashed":
        return "crashed";
      case "running":
        if (!proxy?.isConnected) {
          return proc.uptime && proc.uptime > 5_000 ? "degraded" : "starting";
        }
        if (proxy.tools.length === 0) return "degraded";
        return "ready";
    }
  }

  private modeForConfig(config: ActiveConnectionConfig): ConnectionHealth["mode"] {
    if (!config.enabled) return "disabled";
    return config.definition.mode ?? "managed";
  }

  private findLastError(proc: ManagedProcess | undefined): string | undefined {
    if (!proc) return undefined;
    const errorLine = [...proc.recentLogs]
      .reverse()
      .find(
        (l) =>
          l.level === "stderr" &&
          (l.text.toLowerCase().includes("error") ||
            l.text.toLowerCase().includes("exception"))
      );
    return errorLine?.text;
  }

  private buildAssistantSummary(
    id: ConnectionId,
    name: string,
    status: ConnectionHealthStatus,
    lastError: string | undefined,
    toolCount: number,
    hiddenToolCount: number
  ): string {
    const parts: string[] = [
      `Connection "${name}" (id: ${id}) is in state: ${status}.`,
    ];

    switch (status) {
      case "ready":
        parts.push(`${toolCount} tools are available.`);
        if (hiddenToolCount > 0) {
          parts.push(
            `${hiddenToolCount} advanced or unsafe tools are hidden by safety policy.`
          );
        }
        break;
      case "crashed":
        parts.push("The server process exited unexpectedly.");
        if (lastError) parts.push(`Last error: ${lastError}`);
        parts.push(
          "The user can click Restart to try again, or open Diagnostics for more details."
        );
        break;
      case "auth_required":
        parts.push(
          "The connection needs authentication. The user should click Sign In to complete the OAuth flow."
        );
        break;
      case "not_configured":
        parts.push(
          "The connection has not been set up yet. The user should open Settings to configure it."
        );
        break;
      case "dependency_missing":
        parts.push(
          "A required tool or package is not installed. The user should click Install to set it up."
        );
        break;
      case "blocked_by_policy":
        parts.push(
          "An admin policy is preventing this connection. The user should contact their IT administrator."
        );
        break;
      case "degraded":
        parts.push(`Only ${toolCount} tools are working. Some features may be unavailable.`);
        break;
      case "unsafe_disabled":
        parts.push(
          "This connection is disabled by default because it can run code or control external systems. The user can enable it in Settings if they trust it."
        );
        break;
      case "version_mismatch":
        parts.push("The downstream server version is not compatible. The user should update the connection or extension.");
        break;
      default:
        break;
    }

    return parts.join(" ");
  }
}
