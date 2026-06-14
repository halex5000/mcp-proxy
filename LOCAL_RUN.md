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

## Two UX surfaces

There are two ways to view connections, and they serve different audiences:

| Surface | Where | Audience | Purpose |
| --- | --- | --- | --- |
| **Connections Center** (webview) | Main editor tab | End users | **Primary product UX.** A polished, app-style dashboard of capability cards. This is the experience we are designing for. |
| **Connections view** (TreeView) | Activity Bar sidebar | Developers | Dev/debug quick-status hatch. Proves the plumbing; not the product. |

Verify both, but treat the **Connections Center** as the real deliverable.

## 6a. Open The Connections Center (primary product UX)

In the Extension Development Host:

1. Run the command `Managed Connections: Open Connections Center`
   (`Cmd/Ctrl+Shift+P` → type "Connections Center"), **or** click the
   `Open Connections Center` button in the Connections sidebar toolbar.
2. A full webview opens as an editor tab titled **Connections Center**.

Expected dashboard:

- Header "Connections" with a "Manage what the assistant can access." subtitle,
  plus `Refresh` and `Verify setup` buttons.
- A summary strip: **Ready / Needs attention / Not set up / Disabled** counts.
- A "Needs attention" banner if anything is crashed / needs sign-in / degraded.
- One capability card per connection:

```text
🧪 Test Echo            ✓ Connected
3 tools available. Proves the local gateway is working end to end.
[↻ Restart]  [Simulate ▾]   ▸ Technical details

🐙 GitHub               🔑 Needs sign-in
Work with repositories, issues, and pull requests.
[🔑 Sign in]            ▸ Technical details

📚 Project Knowledge    ○ Not set up
Let the assistant recall and link your project's local files and docs.
[Set up]                ▸ Technical details

🗂️ Jira & Confluence    ○ Not set up
Search Confluence docs and create or update Jira issues.
[Set up]                ▸ Technical details

🌐 Browser Automation   ⊘ Disabled
Safe browser automation for navigating and reading web pages.
[Enable safe mode]      ▸ Technical details
```

Things to try from the webview (every action is mediated by the extension —
the webview never talks to the gateway directly):

- **Refresh** and **Verify setup** from the header.
- **Restart** Test Echo.
- **Simulate** a Test Echo failure mode (pick from the dropdown, click Simulate),
  then watch the card flip to the matching friendly state and the summary update.
- Expand **Technical details** on a card → **Copy diagnostics JSON** / **Open full diagnostics**.
- Expand the **Advanced diagnostics** section at the bottom → gateway status, port,
  connection-state JSON, hidden unsafe tools, and **Copy diagnostics JSON**.

Normal users should never see raw MCP / protocol / process errors unless they
expand a Technical details or Advanced diagnostics disclosure.

## 6b. Find The Connections View (dev/debug sidebar)

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
