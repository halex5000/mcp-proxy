# Demo Script

Audience: product/technical reviewer.

Thesis:

> MCP is infrastructure, not UX. Users connect capabilities, not manage servers.

## Prep

```bash
npm install
npm run build
```

Open VS Code, press `F5`, and use the Extension Development Host for the demo.

## Script

### 1. Open Connections

Show the Connections activity view.

Expected:

```text
Test Echo        Connected
GitHub           Connected or Needs sign-in
Jira             Needs sign-in / Not set up
Browser          Disabled
```

Say: "The user sees connections and capabilities, not MCP servers."

### 2. Use Copilot Echo Tool

Paste into Copilot Chat:

```text
Use the MCP echo test tool and tell me exactly what it returns.
```

Expected: Copilot calls `test-echo__echo` and reports `fake-mcp-server`, `mode: ready`.

### 3. Show Assistant-Readable Health

Prompt:

```text
Check the current connection health using the available MCP tools.
```

Expected: Copilot calls `connection_health` or `connections_status` and summarizes `Test Echo` as ready.

### 4. Simulate Crash

Connections panel:

1. Right-click `Test Echo`.
2. `Simulate Connection State`.
3. Pick `crash_after_delay`.

Wait two seconds.

Expected: `Test Echo` changes to `Crashed` / Restart needed.

### 5. Ask What Is Wrong

Prompt:

```text
Why is Test Echo unavailable?
```

Expected:

```text
Test Echo crashed. The managed connection process exited unexpectedly. You can restart it from the Connections panel.
```

### 6. Restart

Connections panel:

1. Right-click `Test Echo`.
2. `Restart Connection`.

Expected: `Test Echo` returns to `Connected`.

### 7. Use Tool Again

Prompt:

```text
Use the echo test tool again.
```

Expected: echo works again and reports `mode: ready`.

### 8. Show Unsafe Tools Are Hidden

Connections panel:

1. Right-click `Test Echo`.
2. `Simulate Connection State`.
3. Pick `unsafe_tools`.

Prompt:

```text
What tools are available through the managed gateway, and are any unsafe tools hidden?
```

Expected:

- Safe tools are listed.
- Unsafe tools are not listed as callable.
- Assistant says advanced tools are hidden by safety policy.

### 9. Open Advanced Diagnostics

Right-click `Test Echo` -> `Open Diagnostics`.

Expected:

- Raw details are available.
- Normal UI did not force the user into raw logs.

## Pass Line

At no point should the reviewer need:

- terminal commands after launch
- output panel for normal use
- raw logs
- `mcp.json`
- server process IDs
- MCP protocol details

The visible product behavior is "Connections", while MCP remains infrastructure.
