# Slay Test

Purpose: product-level acceptance test for the thesis:

> MCP is infrastructure, not UX. Users connect capabilities, not manage servers.

## User Acceptance Bar

The system passes when a non-technical user can:

1. Open the app.
2. See connection status.
3. Understand what is connected.
4. Understand what needs action.
5. Fix restartable problems with one click.
6. Reconnect auth-required tools through a friendly or simulated flow.
7. Ask the assistant what is wrong and get a useful answer.
8. Use Copilot tools without editing MCP config.
9. Avoid raw MCP/server/protocol errors.
10. Avoid unsafe tools being exposed by default.

## Scripted Demo

### 1. Start App

```bash
npm run build
```

Press `F5` in VS Code and launch `Run Extension`.

Expected UI:

```text
Connections
  Test Echo        Connected
```

### 2. Ask Copilot To Prove Tool Use

Prompt:

```text
Use the MCP echo test tool and tell me exactly what it returns.
```

Expected assistant language:

```text
The test echo tool returned a response from the fake MCP server. It includes marker fake-mcp-server and mode ready.
```

Prompt:

```text
Check the current connection health using the available MCP tools.
```

Expected assistant language:

```text
Test Echo is connected and working. No action is needed.
```

### 3. Simulate Downstream Crash

In the Connections panel:

1. Right-click `Test Echo`.
2. Choose `Simulate Connection State`.
3. Pick `crash_after_delay`.
4. Wait about two seconds.

Expected UI:

```text
Test Echo
Restart needed / Crashed
Something went wrong. Click Restart to try again.
[Restart] [Advanced]
```

### 4. Ask Copilot What Is Wrong

Prompt:

```text
Why are the local test tools unavailable?
```

Expected assistant language:

```text
The Test Echo connection crashed. The managed connection process exited unexpectedly. You can restart it from the Connections panel.
```

It should not say:

- edit `mcp.json`
- inspect JSON-RPC frames
- run `npx`
- manually start an MCP server

### 5. Recover With One Click

In the Connections panel:

1. Right-click `Test Echo`.
2. Choose `Restart Connection`.

Expected UI:

```text
Test Echo        Connected
```

Prompt:

```text
Use the MCP echo test tool again.
```

Expected assistant language:

```text
The echo tool works again and returned mode ready.
```

### 6. Prove Unsafe Tools Stay Hidden

In the Connections panel:

1. Right-click `Test Echo`.
2. Choose `Simulate Connection State`.
3. Pick `unsafe_tools`.

Prompt:

```text
List the tools available through the managed gateway. Are any advanced or unsafe tools hidden?
```

Expected assistant language:

```text
The safe Test Echo tools are available. Some advanced tools are hidden by safety policy.
```

Unsafe tools such as `shell_exec`, `delete_files`, and `browser_run_code_unsafe` must not appear in Copilot's `tools/list`.

## Pass Criteria

- User can complete the flow without terminal, raw logs, `mcp.json`, or VS Code MCP internals.
- Connections panel uses plain product states.
- Assistant explains failures from structured health.
- Restart recovers the connection.
- Safe tools work before and after recovery.
- Unsafe tools are hidden before Copilot sees them.

## Fail Criteria

- User has to edit `mcp.json`.
- User sees raw JSON-RPC/protocol/process errors in normal UI.
- Copilot invents unavailable connections.
- Crash recovery requires terminal commands.
- Unsafe tools appear in MCP `tools/list`.
