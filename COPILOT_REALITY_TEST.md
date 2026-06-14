# Copilot Reality Test

Purpose: prove GitHub Copilot can see and use tools exposed by the extension-owned gateway.

## Setup

```bash
npm install
npm run build
```

Then:

1. Open the repo in VS Code.
2. Press `F5` and choose `Run Extension`.
3. In the Extension Development Host, open the Connections panel.
4. Confirm `Test Echo` is `Connected`.
5. Open Copilot Chat.
6. Make sure the managed MCP server appears in the tools picker as `Managed Connections`.

Do not create or edit `mcp.json`.

## Prompts To Paste

```text
Use the MCP echo test tool and tell me exactly what it returns.
```

Expected response:

```text
The echo tool returned a JSON payload that includes "marker": "fake-mcp-server" and "mode": "ready".
```

```text
Check the current connection health using the available MCP tools.
```

Expected response:

```text
Test Echo is Connected/ready. Its assistant summary says it is connected and working.
```

```text
What connections are available right now, and are any broken?
```

Expected response:

```text
Test Echo is available and ready. Browser Automation may be disabled by safe mode unless enabled. Jira/GitHub states should match the Connections panel.
```

```text
What tools are available through the managed gateway?
```

Expected response:

```text
It should mention safe tools such as test-echo__echo, test-echo__get_fake_data, and assistant diagnostic tools such as connections_status or connection_health.
```

## Hallucination Check

Ask:

```text
Can you use Jira right now? If not, explain using the connection diagnostics.
```

Pass response:

- Copilot uses `connections_status`, `connection_health`, or `connection_diagnostics`.
- Copilot reports the actual Jira state from the Connections panel.
- Copilot does not invent a working Jira connection if it is not configured.
- Copilot does not recommend editing `mcp.json`.

## Pass Criteria

- Copilot sees gateway tools.
- Copilot invokes `test-echo__echo` successfully.
- Copilot can read structured connection health.
- Copilot summarizes healthy/broken states accurately.
- Copilot does not hallucinate unavailable connections.
- The user never edits `mcp.json`.

## If Tools Do Not Appear

1. Confirm `npm run build` succeeds.
2. Confirm the Connections panel shows `Test Echo - Connected`.
3. Open `Output > Managed Connections - Gateway` and look for `GATEWAY_READY port=...`.
4. Restart the Extension Development Host.
5. In Copilot tools UI, manually start/enable `Managed Connections` once. This is a VS Code first-run MCP caching behavior, not an app config step.
