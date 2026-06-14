export const SIMULATION_MODES = [
  "ready",
  "slow_start",
  "crash_on_start",
  "crash_after_delay",
  "crash_during_tool_call",
  "hang",
  "bad_json",
  "auth_required",
  "dependency_missing",
  "version_mismatch",
  "blocked_by_policy",
  "unsafe_tools",
] as const;

export type SimulationMode = (typeof SIMULATION_MODES)[number];

export function isSimulationMode(value: unknown): value is SimulationMode {
  return (
    typeof value === "string" &&
    (SIMULATION_MODES as readonly string[]).includes(value)
  );
}
