import * as vscode from "vscode";
import {
  makeDefaultHealth,
  HEALTH_MESSAGES,
  HEALTH_LABELS,
  actionsForStatus,
} from "@mcp-proxy/shared";
import type { ConnectionHealth, ConnectionHealthStatus } from "@mcp-proxy/shared";

const GITHUB_SCOPES = ["repo", "read:org", "read:user"];

/**
 * RemoteHealthChecker computes ConnectionHealth for connections that are
 * registered directly with VS Code (not via the gateway) — currently GitHub.
 *
 * It can't observe process state (there is none), so health is derived from:
 *   - VS Code authentication session presence + validity (GitHub)
 *   - Stored secrets presence (Atlassian, future)
 *   - A lightweight HTTP probe against the remote endpoint (optional, Phase 5)
 *
 * The HealthMonitor merges these results with gateway-reported health so the
 * tree view has a unified picture of all connections.
 */
export class RemoteHealthChecker {
  async checkGitHub(): Promise<ConnectionHealth> {
    try {
      const session = await vscode.authentication.getSession(
        "github",
        GITHUB_SCOPES,
        { silent: true }
      );

      if (!session) {
        return this.build("auth_required", "github");
      }

      // Session exists — optimistically assume ready. A failed tool call will
      // surface auth_required at the Copilot level; we don't probe the endpoint
      // to avoid unnecessary network traffic on every health poll.
      const health = this.build("ready", "github");
      health.toolCount = -1; // unknown — VS Code tracks this, not us
      health.assistantSummary =
        `GitHub connection is ready. Signed in as ${session.account.label}. ` +
        `GitHub tools (issues, PRs, code search, repos) are available.`;
      health.diagnostics = {
        connectionId: "github",
        crashCount: 0,
        recentLogs: [],
        environment: { GITHUB_USER: session.account.label },
        toolCount: -1,
        hiddenToolCount: 0,
        assistantSummary: health.assistantSummary,
      };
      return health;
    } catch {
      return this.build("degraded", "github");
    }
  }

  private build(status: ConnectionHealthStatus, id: string): ConnectionHealth {
    const now = Date.now();
    const message = HEALTH_MESSAGES[status];
    const actions = actionsForStatus(status);
    return {
      ...makeDefaultHealth(status, id, "external"),
      id,
      mode: "external",
      state: status,
      status,
      label: HEALTH_LABELS[status],
      userMessage: message,
      message,
      assistantSummary: message,
      lastChecked: now,
      lastCheckedAt: new Date(now).toISOString(),
      restartCount: 0,
      crashCount: 0,
      toolCount: 0,
      hiddenToolCount: 0,
      hiddenTools: [],
      availableActions: actions,
      actions,
    };
  }
}
