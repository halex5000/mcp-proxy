# Chaos Test

Purpose: prove ugly downstream failures become clear product states.

Use `Test Echo` as the controlled fake downstream server.

## Setup

```bash
npm install
npm run build
```

Launch the Extension Development Host with `F5`, then use:

1. Connections panel -> right-click `Test Echo`.
2. `Simulate Connection State`.
3. Pick the scenario mode.

For API testing, call:

```bash
curl -s -X POST \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"mode":"crash_after_delay"}' \
  http://127.0.0.1:<port>/control/connections/test-echo/simulate
```

## Scenarios

| Scenario | Mode | Expected health | Panel state | Assistant summary | Actions | Advanced detail |
|---|---|---|---|---|---|---|
| Process crashes | `crash_after_delay` | `crashed` | Restart needed | Process exited unexpectedly; click Restart | Restart, Advanced | exit/crash log |
| Crashes on start | `crash_on_start` | `crashed` or `degraded` | Restart needed | Server crashed during startup | Restart, Advanced | exit code 42 |
| Hangs before initialize | `hang` | `degraded` after timeout | Some features unavailable | Server is running but MCP did not become available | Restart, Advanced | timed out connecting |
| Invalid JSON | `bad_json` | `degraded` | Some features unavailable | Server emitted invalid protocol data | Restart, Advanced | JSON parse/proxy error |
| Slow start | `slow_start` | `starting` then `ready` | Starting -> Connected | Getting ready, then connected | Advanced | slow-start log |
| Requires auth | `auth_required` | `auth_required` | Needs sign-in | User needs to reconnect/sign in | Connect, Advanced | simulated auth_required |
| Missing dependency | `dependency_missing` | `dependency_missing` | Setup needed | Required tool must be installed | Install, Advanced | simulated dependency_missing |
| Version mismatch | `version_mismatch` | `version_mismatch` | Update required | Downstream version is incompatible | Update, Advanced | simulated version_mismatch |
| Crash during tool call | `crash_during_tool_call` | `crashed` after echo call | Restart needed | Tool call caused downstream process to exit | Restart, Advanced | exit code 44 |
| Unsafe tools exposed downstream | `unsafe_tools` | `ready` with hidden tools | Connected / Advanced tools hidden | Safe tools available; unsafe tools hidden | Advanced | hidden tool list |

## Recovery

For restartable failures:

1. Right-click `Test Echo`.
2. Choose `Restart Connection`.
3. Expected: state returns to `ready`.
4. Ask Copilot to use `test-echo__echo`.
5. Expected: tool works.

## Infinite Restart Loop Check

When auto-restart is enabled and a server repeatedly crashes, `ManagedProcess` stops auto-restarting after three crashes and leaves the connection in a clear `crashed` state. Manual Restart remains available.

## Pass Criteria

- No scenario hangs `/control/status` forever.
- Hung MCP initialize times out and becomes `degraded`.
- Crash modes become `crashed` with Restart available.
- Auth/dependency/version/policy modes use friendly health overrides.
- Restart recovers the fake connection.
- Assistant summaries are plain English.
- Raw stderr/protocol details are available only in Advanced Diagnostics.
