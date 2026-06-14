/**
 * Health model for managed MCP connections.
 *
 * These states map directly to user-facing UX — every state has a
 * human-readable label, a set of available actions, and an assistant-readable
 * summary so Copilot can explain connection problems autonomously.
 */

export type ConnectionHealthStatus =
  | "ready"              // Connected and all tools available
  | "starting"           // Process launching, not yet accepting calls
  | "stopping"           // Graceful shutdown in progress
  | "not_configured"     // Missing required config (no creds, no server URL)
  | "auth_required"      // Config present but token expired or missing
  | "degraded"           // Running but subset of tools failing
  | "crashed"            // Process exited unexpectedly
  | "dependency_missing" // Required binary or npm package not installed
  | "blocked_by_policy"  // Admin/org policy prevents this connection
  | "version_mismatch"   // MCP server version incompatible with host
  | "unsafe_disabled";   // Disabled because it executes arbitrary code (safe default)

export type HealthAction =
  | "sign-in"
  | "sign-out"
  | "restart"
  | "open-settings"
  | "install-dependency"
  | "open-diagnostics"
  | "contact-admin"
  | "update-extension"
  | "enable"
  | "disable";

export interface StructuredDiagnostics {
  connectionId: string;
  serverVersion?: string;
  runtimeVersion?: string;
  lastError?: string;
  lastErrorAt?: number;
  crashCount: number;
  recentLogs: string[];           // Last 50 lines, newest first
  environment: Record<string, string>; // Sanitized — no secrets
  toolCount: number;
  hiddenToolCount: number;
  /** Plain-language summary for Copilot to read and relay to the user. */
  assistantSummary: string;
}

export interface ConnectionHealth {
  status: ConnectionHealthStatus;
  /** Short user-facing label, e.g. "Connected", "Needs sign-in", "Restarting" */
  label: string;
  /** One-sentence explanation for the user. */
  message: string;
  /** Technical detail for diagnostics panel. */
  detail?: string;
  lastChecked: number;            // Unix ms
  startedAt?: number;             // Unix ms, when process last started
  crashCount: number;
  nextRetryAt?: number;           // Unix ms, for auto-restart backoff
  toolCount: number;
  hiddenToolCount: number;
  /** What the user can do right now. Drives button rendering. */
  actions: HealthAction[];
  diagnostics?: StructuredDiagnostics;
}

export const HEALTH_LABELS: Record<ConnectionHealthStatus, string> = {
  ready: "Connected",
  starting: "Starting…",
  stopping: "Stopping…",
  not_configured: "Not set up",
  auth_required: "Needs sign-in",
  degraded: "Partial",
  crashed: "Crashed",
  dependency_missing: "Setup needed",
  blocked_by_policy: "Blocked",
  version_mismatch: "Update required",
  unsafe_disabled: "Disabled (safe mode)",
};

export const HEALTH_MESSAGES: Record<ConnectionHealthStatus, string> = {
  ready: "Connected and working.",
  starting: "Getting ready — this usually takes a few seconds.",
  stopping: "Shutting down.",
  not_configured: "This connection needs to be set up before it can be used.",
  auth_required: "Sign in to continue using this connection.",
  degraded: "Connected, but some features may not be available.",
  crashed: "Something went wrong. Click Restart to try again.",
  dependency_missing: "A required tool needs to be installed first.",
  blocked_by_policy: "Your organization's settings are preventing this connection.",
  version_mismatch: "An update is needed before this connection will work.",
  unsafe_disabled: "Disabled by default because it can run code. Enable it in Settings if you trust it.",
};

export function makeDefaultHealth(
  status: ConnectionHealthStatus = "not_configured"
): ConnectionHealth {
  return {
    status,
    label: HEALTH_LABELS[status],
    message: HEALTH_MESSAGES[status],
    lastChecked: Date.now(),
    crashCount: 0,
    toolCount: 0,
    hiddenToolCount: 0,
    actions: actionsForStatus(status),
  };
}

export function actionsForStatus(status: ConnectionHealthStatus): HealthAction[] {
  switch (status) {
    case "ready":
      return ["open-diagnostics", "disable"];
    case "starting":
      return [];
    case "stopping":
      return [];
    case "not_configured":
      return ["open-settings", "open-diagnostics"];
    case "auth_required":
      return ["sign-in", "open-diagnostics"];
    case "degraded":
      return ["open-diagnostics", "restart"];
    case "crashed":
      return ["restart", "open-diagnostics"];
    case "dependency_missing":
      return ["install-dependency", "open-diagnostics"];
    case "blocked_by_policy":
      return ["open-diagnostics", "contact-admin"];
    case "version_mismatch":
      return ["update-extension", "open-diagnostics"];
    case "unsafe_disabled":
      return ["enable", "open-diagnostics"];
  }
}
