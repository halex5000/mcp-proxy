import type { ConnectionDefinition, ConnectionId, SimulationMode } from "@mcp-proxy/shared";

/**
 * A connection is "auth-capable" when signing in is a meaningful action for it:
 * either it authenticates through an OAuth provider (GitHub) or it requires a
 * secret credential the user must supply (Atlassian API token). Connections with
 * no auth surface — Test Echo, Project Knowledge, Browser Automation — are
 * excluded so they never clutter the Sign In picker.
 */
export function isAuthCapable(def: ConnectionDefinition): boolean {
  if (def.oauthConfig) return true;
  return def.requiredConfig.some((field) => field.type === "secret");
}

export const SIMULATION_PICKER_MODES: SimulationMode[] = [
  "ready",
  "crash_after_delay",
  "auth_required",
  "dependency_missing",
  "version_mismatch",
  "unsafe_tools",
];

export function nextEnabledConnections(
  current: string[],
  id: ConnectionId,
  enable: boolean
): string[] {
  return enable
    ? [...new Set([...current, id])]
    : current.filter((connectionId) => connectionId !== id);
}

export function simulationDescription(mode: SimulationMode): string {
  switch (mode) {
    case "ready":
      return "Healthy fake downstream server";
    case "slow_start":
      return "Starts slowly, then becomes ready";
    case "crash_on_start":
      return "Process exits immediately";
    case "crash_after_delay":
      return "Process starts, then exits";
    case "crash_during_tool_call":
      return "Crashes when echo is invoked";
    case "hang":
      return "Process never answers MCP initialize";
    case "bad_json":
      return "Emits invalid JSON on stdout";
    case "auth_required":
      return "Shows friendly sign-in required state";
    case "dependency_missing":
      return "Shows setup needed state";
    case "version_mismatch":
      return "Shows update required state";
    case "blocked_by_policy":
      return "Shows admin blocked state";
    case "unsafe_tools":
      return "Exposes unsafe fixture tools downstream";
  }
}
