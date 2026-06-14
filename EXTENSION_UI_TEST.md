# Extension UI Test

Purpose: prove the Connections panel feels like product UX, not developer tooling.

Normal UI should never show raw MCP, JSON-RPC, stdio, process, or protocol errors. Those belong only in Advanced Diagnostics.

## Required States

| State | Icon | Label | Explanation | Primary action | Secondary action | Advanced diagnostics |
|---|---|---|---|---|---|---|
| `ready` | `check` | Connected | Connected and working. | None | Advanced | tool count, hidden tools, uptime |
| `starting` | `loading~spin` | Starting | Getting ready. This usually takes a few seconds. | None | Advanced | process state, startup logs |
| `auth_required` | `key` | Needs sign-in | Sign in again so the assistant can use this connection. | Connect | Advanced | auth provider/state, no secrets |
| `crashed` | `error` | Restart needed | Something went wrong. Click Restart to try again. | Restart | Advanced | exit code, recent stderr |
| `degraded` | `warning` | Some features unavailable | Connected, but some features may not be available. | Restart | Advanced | proxy/connect timeout, hidden errors |
| `blocked_by_policy` | `lock` | Blocked by admin settings | Your organization's settings are preventing this connection. | Contact admin | Advanced | policy identifier if known |
| `version_mismatch` | `versions` | Update required | An update is needed before this connection will work. | Update | Advanced | required/current version |
| `unsafe_disabled` | `circle-slash` | Disabled | Disabled by default because it can run code. | Enable | Advanced | safety policy explanation |
| hidden tools | `shield` or `info` | Advanced tools hidden | Some advanced tools are hidden for safety. | None | Advanced | hidden tool names/reasons |
| disabled | `circle-outline` | Disabled | This connection is not enabled. | Enable | Advanced | no process owned |

## Example Cards

```text
Jira
Needs sign-in
Sign in again so the assistant can read related tickets.
[Connect] [Advanced]
```

```text
Test Echo
Restart needed
Something went wrong. Click Restart to try again.
[Restart] [Advanced]
```

```text
Browser Automation
Disabled
Disabled by default because it can run code.
[Enable] [Advanced]
```

## Test Flow

1. Launch Extension Development Host.
2. Open Connections panel.
3. Verify `Test Echo - Connected`.
4. Simulate `auth_required`; verify label `Needs sign-in`.
5. Simulate `dependency_missing`; verify label `Setup needed`.
6. Simulate `version_mismatch`; verify label `Update required`.
7. Simulate `blocked_by_policy`; verify label `Blocked`.
8. Simulate `unsafe_tools`; verify safe connected state plus hidden-tools note.
9. Simulate `crash_after_delay`; verify `Crashed`/Restart needed.
10. Open Advanced Diagnostics; verify raw detail is present there only.

## Pass Criteria

- Each state has an icon, label, one-line explanation, and action.
- Normal UI uses user language.
- Advanced Diagnostics contains raw details without secrets.
- No normal UI text asks users to edit `mcp.json`, manage ports, or debug MCP protocol.
