# Local Run-Through

This is the literal path for testing the spike from a fresh clone.

## 1. Install

```bash
npm install
```

Expected: npm finishes without vulnerabilities that block install.

## 2. Build

```bash
npm run build
```

Expected packages:

```text
@mcp-proxy/shared
@mcp-proxy/gateway
@mcp-proxy/fake-mcp-server
managed-mcp-connections
```

All should build cleanly.

## 3. Run Automated Proofs

```bash
npm run smoke
npm test
npm run test:vscode
```

Expected:

- `npm run smoke` passes the gateway/fake MCP lifecycle proof.
- `npm test` passes unit, UI, and gateway integration tests.
- `npm run test:vscode` launches a real VS Code Extension Development Host and passes.

The first `npm run test:vscode` may download a VS Code test build into `.vscode-test/`.

## 4. Open The Repo

```bash
code .
```

## 5. Launch The Extension Development Host

In VS Code:

1. Open the Run and Debug sidebar.
2. Select `Run Extension`.
3. Press `F5`.
4. A new window opens with `[Extension Development Host]` in the title.

Use the Extension Development Host window for the rest of this test.

## 6. Find The Connections View

In the Extension Development Host:

1. Look at the left Activity Bar.
2. Find the `Connections` icon. It looks like linked nodes / a small network plug.
3. Click it.

Expected Connections panel:

```text
Test Echo                Connected
  3 tools available
Project Knowledge        Not set up
GitHub                   Needs sign-in
Jira & Confluence        Not set up
Browser Automation       Disabled
```

The important proof row is `Test Echo`.

## 7. Verify Test Echo

Confirm:

- `Test Echo` says `Connected`.
- Expanding it shows `3 tools available`.
- Right-clicking it shows:
  - `Restart Connection`
  - `Simulate Connection State`
  - `Open Diagnostics`
  - `Copy Diagnostics JSON`

## 8. Check Gateway Output

In the Extension Development Host:

1. Open `View -> Output`.
2. In the output channel dropdown, select `Managed Connections Gateway`.

Expected output includes:

```text
GATEWAY_READY port=XXXXX
MCP endpoint: http://127.0.0.1:XXXXX/mcp
```

## 9. Run One-Command Verification

Open the Command Palette:

```text
Managed Connections: Verify Local Setup
```

Expected:

- An information message says the setup looks good.
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

## 10. Manual Copilot Echo Test

Open Copilot Chat in the Extension Development Host.

Paste:

```text
Use the MCP echo test tool and tell me exactly what it returns.
```

Expected:

- Copilot uses `test-echo__echo`.
- The answer mentions `fake-mcp-server`.
- No `mcp.json` edit is required.

If tools do not appear, open the Copilot tools UI and manually enable/start `Managed Connections` once. This is a VS Code first-run MCP registration behavior.
