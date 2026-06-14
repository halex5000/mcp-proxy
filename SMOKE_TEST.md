# Smoke Test

Purpose: prove the basic managed gateway system boots, has a pulse, exposes MCP tools, and requires no manual `mcp.json` editing.

## Automated Smoke

```bash
npm install
npm run smoke
```

Expected output:

```text
> smoke
> npm run build && node --test tests/gateway.integration.test.mjs

ok 1 - gateway boots, exposes control status, proxies fake echo, filters unsafe tools, and recovers
1..1
# pass 1
# fail 0
```

This proves:

- extension, gateway, shared, and fake downstream packages build
- gateway starts and reports `GATEWAY_READY port=XXXXX`
- `/control/status` responds
- MCP initialize succeeds through `/mcp`
- MCP `tools/list` returns gateway tools and `test-echo__echo`
- `test-echo__echo` can be invoked through the gateway
- unsafe downstream tools are filtered before MCP `tools/list`
- crash simulation recovers through `/control/connections/test-echo/restart`

## Manual Gateway Pulse

Terminal 1:

```bash
npm run build
GATEWAY_AUTH_TOKEN=devtoken node packages/gateway/dist/index.js
```

Expected output:

```text
GATEWAY_READY port=51234
MCP endpoint: http://127.0.0.1:51234/mcp
```

Terminal 2, replacing `51234` with the printed port:

```bash
PORT=51234
curl -s \
  -H "Authorization: Bearer devtoken" \
  -H "Content-Type: application/json" \
  --data @samples/fake-gateway-config.json \
  http://127.0.0.1:$PORT/control/configure
```

Expected:

```json
{"ok":true,"errors":[]}
```

Check status:

```bash
curl -s -H "Authorization: Bearer devtoken" \
  http://127.0.0.1:$PORT/control/status
```

Expected:

```json
{
  "connections": [
    {
      "id": "test-echo",
      "health": {
        "state": "ready",
        "label": "Connected"
      }
    }
  ]
}
```

## VS Code Startup Check

1. Open this repo in VS Code.
2. Press `F5` and choose `Run Extension`.
3. In the Extension Development Host, open the Connections activity view.
4. Expected: `Test Echo` appears as `Connected`.
5. Open `Output > Managed Connections - Gateway`.
6. Expected: gateway output includes `GATEWAY_READY port=XXXXX`.

VS Code MCP registration check:

1. Open Copilot Chat in the Extension Development Host.
2. Open the tools/agent tools picker.
3. Expected: a managed server named `Managed Connections` is available.
4. No file named `mcp.json` should need to be created or edited.

## Pass Criteria

- `npm run build` succeeds.
- `npm run smoke` succeeds.
- Gateway prints `GATEWAY_READY port=XXXXX`.
- `/control/status` returns JSON.
- MCP initialize, `tools/list`, and `test-echo__echo` all succeed.
- VS Code sees the provider-registered gateway.
- No manual `mcp.json` edit is required.

## Troubleshooting

- `Cannot find module ...packages/extension/dist/gateway/index.js`: rebuild and make sure `packages/gateway/dist/index.js` exists. The extension now resolves the sibling gateway package in dev.
- `401 Unauthorized`: use the same `GATEWAY_AUTH_TOKEN` value in the gateway env and `Authorization: Bearer ...` header.
- `Test Echo` missing: run `npm run build`; the fake server entrypoint is `packages/fake-mcp-server/dist/index.js`.
- MCP tools do not appear in Copilot: restart the Extension Development Host and manually start/enable the managed MCP server once from the Copilot tools UI. Do not edit `mcp.json`.
