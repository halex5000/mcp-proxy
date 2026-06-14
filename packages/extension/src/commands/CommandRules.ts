import type { ConnectionId, SimulationMode } from "@mcp-proxy/shared";

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
