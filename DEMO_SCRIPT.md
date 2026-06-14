# Demo Script

Audience: product/technical reviewer.

Thesis:

> MCP is infrastructure, not UX. Users connect capabilities, not manage servers.

## Prep

```bash
npm install
npm run build
npm run smoke
npm test
```

Then:

```bash
code .
```

## Demo Flow

### 1. Launch Extension Development Host

In VS Code:

1. Open Run and Debug.
2. Select `Run Extension`.
3. Press `F5`.
4. Use the new `[Extension Development Host]` window.

### 2. Open Connections View

In the Extension Development Host:

1. Look at the left Activity Bar.
2. Click the `Connections` icon. It looks like linked nodes / a small network plug.

Expected:

```text
Connections
  Test Echo                Connected
    3 tools available
  Project Knowledge        Not set up
  GitHub                   Needs sign-in
  Jira & Confluence        Not set up
  Browser Automation       Disabled
```

Say: "Users see connections and capabilities, not MCP servers."

### 3. Show Test Echo As Connected

Click `Test Echo`.

Right-click it and point out:

- `Refresh Connections`
- `Restart Connection`
- `Simulate Connection State`
- `Open Diagnostics`
- `Copy Diagnostics JSON`

### 4. Run Verify Local Setup

Open Command Palette:

```text
Managed Connections: Verify Local Setup
```

Expected:

- A markdown verification report opens.
- The report shows:
  - extension activated
  - gateway process running
  - gateway port discovered
  - `/control/status` responding
  - MCP endpoint responding
  - Test Echo connected
  - tools exposed
  - unsafe tools not visible

### 5. Ask Assistant To Use Echo Tool

In Copilot/Claude/assistant chat, paste:

```text
Use the MCP echo test tool and tell me exactly what it returns.
```

Expected:

- Assistant calls `test-echo__echo` if MCP tools are available.
- Response includes `fake-mcp-server` and `mode: ready`.
- No `mcp.json` editing.

### 6. Simulate Crash

In Connections:

1. Right-click `Test Echo`.
2. Select `Simulate Connection State`.
3. Pick `crash_after_delay`.
4. Wait about two seconds.

Expected:

```text
Test Echo        Crashed / Restart needed
```

### 7. Show Panel Changes

Point out that the normal UI says something like:

```text
Something went wrong. Click Restart to try again.
```

It does not show JSON-RPC, stdio, stack traces, port numbers, or `mcp.json`.

### 8. Ask Assistant What Is Wrong

Prompt:

```text
Why is Test Echo unavailable?
```

Expected:

```text
Test Echo crashed. The managed connection process exited unexpectedly. You can restart it from the Connections panel.
```

### 9. Restart Connection

In Connections:

1. Right-click `Test Echo`.
2. Select `Restart Connection`.

Expected:

```text
Test Echo        Connected
```

### 10. Show It Returns To Connected

Prompt:

```text
Use the echo test tool again.
```

Expected:

- Assistant calls `test-echo__echo`.
- Response includes `mode: ready`.

### 11. Simulate Unsafe Tools

In Connections:

1. Right-click `Test Echo`.
2. Select `Simulate Connection State`.
3. Pick `unsafe_tools`.

Expected:

```text
Test Echo        Connected
  3 tools available
  advanced tools hidden
```

### 12. Prove Unsafe Tools Are Hidden

Prompt:

```text
List the tools available through the managed gateway. Are unsafe tools such as shell_exec, delete_files, or browser_run_code_unsafe available?
```

Expected:

- Safe tools are listed.
- Unsafe tools are not listed as callable.
- Assistant says advanced tools are hidden for safety.

### 13. Open Diagnostics

Right-click `Test Echo` -> `Open Diagnostics`.

Expected:

- Technical detail and logs are available.
- Normal Connections UX stayed friendly.
- The user did not need terminal, raw logs, `mcp.json`, process IDs, or MCP protocol details.

## Pass Line

The reviewer should see:

- visible first-class Connections Activity Bar icon
- deterministic local Test Echo connection
- one-command local setup verification
- crash and restart without terminal
- unsafe tools filtered before assistant exposure
- diagnostics available only when requested

The product thesis holds when MCP remains infrastructure and the user only manages connections.
