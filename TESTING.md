# Testing Guide — Managed MCP Connections

Step-by-step instructions to run and test the extension in VS Code, from a cold clone to verified Copilot tool calls.

---

## Prerequisites

| Requirement | Version | Check |
|---|---|---|
| Node.js | ≥ 20 | `node --version` |
| npm | ≥ 10 | `npm --version` |
| VS Code | ≥ 1.99 | Check **Help → About** |
| GitHub Copilot | Active subscription | Extension installed + signed in |

> **VS Code 1.99+** is required for the `registerMcpServerDefinitionProvider` API and `McpHttpServerDefinition`. If you're on an older build, grab [VS Code Insiders](https://code.visualstudio.com/insiders/).

---

## 1. Clone and Build

```bash
git clone https://github.com/halex5000/mcp-proxy.git
cd mcp-proxy
npm install
npm run build
```

You should see three clean build outputs:
```
> @mcp-proxy/shared@0.1.0 build  ✓
> @mcp-proxy/gateway@0.1.0 build ✓
> managed-mcp-connections@0.1.0 build ✓
```

---

## 2. Open the Repo in VS Code

```bash
code .
```

When it opens, **accept the "Install recommended extensions" prompt** if it appears (for TypeScript IntelliSense).

---

## 3. Launch the Extension Development Host

Press **F5** (or **Run → Start Debugging → "Run Extension"**).

This will:
1. Run a build (the `build-all` pre-launch task)
2. Open a new VS Code window labeled **[Extension Development Host]**
3. Start the extension, which spawns the gateway process in the background

**You do all your testing in the Extension Development Host window.**

> If F5 fails with a build error, run `npm run build` in the terminal and use the **"Run Extension (no build)"** launch config instead.

---

## 4. Find the Connections Panel

In the Extension Development Host window:

1. Look for the **Connections icon** in the Activity Bar (left sidebar) — it looks like a plug/link icon.
2. Click it to open the **Connections** panel.

You should see all four connections listed:

```
CONNECTIONS
  ⟳ Project Knowledge     Starting…
  ○ GitHub                Not set up
  ○ Jira & Confluence     Not set up
  ⊘ Browser Automation    Disabled (safe mode)
```

> If the panel doesn't appear, check **View → Open View → Connections**.

---

## 5. Test: Phase 1 — Project Knowledge (Local MCP)

**What it does:** Gives Copilot read access to your workspace files.

**Expected state after a few seconds:**
```
  ✓ Project Knowledge     Connected
    5 tools available
```

**Test it in Copilot Chat:**
```
What files are in the root of this workspace?
```
Copilot should list the actual files by calling the `local-knowledge__list_directory` tool.

**Test restart:**
1. Right-click "Project Knowledge" → **Restart Connection**
2. Watch it go `Starting…` then `Connected` again

**Test diagnostics:**
1. Right-click "Project Knowledge" → **Open Diagnostics**
2. A panel opens showing: tool count, recent logs, server version

---

## 6. Test: Phase 2 — GitHub

**What it does:** Issues, PRs, code search, repos via GitHub's remote MCP at `api.githubcopilot.com/mcp/`.

### 6a. Sign in

The Connections panel should show:
```
  🔑 GitHub     Needs sign-in
```

Click the key icon or right-click → **Sign In**. VS Code's standard GitHub auth flow runs (same one used by the built-in GitHub extension — you may already be signed in).

After sign-in:
```
  ✓ GitHub     Connected
```

### 6b. Test in Copilot Chat

```
List the open issues in the halex5000/mcp-proxy repo
```

```
Show me the last 3 commits on the main branch
```

> **Note:** GitHub's remote MCP endpoint must be enabled for your Copilot plan. If you get "tool not found" errors, GitHub may not have enabled remote MCP for your account yet — this is in rollout as of mid-2026.

### 6c. Test auth_required path

1. Sign out of GitHub in VS Code (**Accounts** icon → sign out of GitHub)
2. The health monitor will detect this within 5 seconds
3. Panel shows: `🔑 GitHub — Needs sign-in`
4. Sign back in via the panel

---

## 7. Test: Phase 3 — Jira & Confluence

**What it does:** Search tickets, create issues, read Confluence pages.

**Requires:**
- An Atlassian account with Jira/Confluence access
- An API token from [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
- `@atlassian/mcp-atlassian` installable via npx (will be fetched on first use)

### 7a. Check connection state

Panel should show:
```
  ○ Jira & Confluence     Not set up
```

### 7b. Enable it

Add `"atlassian"` to the enabled connections list:

1. Open VS Code Settings (`Ctrl+,` / `Cmd+,`)
2. Search for `managedConnections.enabledConnections`
3. Add `"atlassian"` to the array

Panel changes to:
```
  🔑 Jira & Confluence    Needs sign-in
```

### 7c. Sign in

Right-click → **Sign In** (or click the key icon). A 3-step flow:
1. **Site name** — enter your Atlassian subdomain (e.g. `yourcompany` for `yourcompany.atlassian.net`)
2. **Email** — your Atlassian account email
3. **API token** — the extension offers to open the token page for you

After sign-in, the extension checks if `@atlassian/mcp-atlassian` is installed:
- If missing: `↓ Jira & Confluence — Setup needed` → right-click → **Install Required Tools**
- If installed: `⟳ Starting…` → `✓ Connected`

### 7d. Test in Copilot Chat

```
Search for open bugs in Jira
```

```
Find Confluence pages about our onboarding process
```

### 7e. Test dependency_missing path (if you want to see the state)

Temporarily change the check command in `ConnectionRegistry.ts` to something that will fail, rebuild, and relaunch to see the `dependency_missing` state and install flow.

---

## 8. Test: Phase 4 — Browser Automation (Playwright)

**What it does:** Browse websites, take screenshots, extract content.
**Off by default** — requires explicit opt-in because it can execute JavaScript.

### 8a. See the disabled state

```
  ⊘ Browser Automation    Disabled (safe mode)
```

Right-click → you'll see **Enable** as an option.

### 8b. Enable it

1. Open Settings → `managedConnections.enabledConnections`
2. Add `"playwright"` to the array

The extension checks for `@playwright/mcp`. If not installed:
```
  ↓ Browser Automation    Setup needed
```

Right-click → **Install Required Tools** — opens a terminal and runs the install.

After install, re-push config (change and revert any setting, or restart the Extension Development Host). Connection goes:
```
  ⟳ Browser Automation    Starting…
  ✓ Browser Automation    Connected
    12 tools available (8 hidden in safe mode)
```

### 8c. Test in Copilot Chat (safe mode)

```
Navigate to https://example.com and tell me what the page says
```

Playwright will navigate, take a screenshot, and return the page content. Safe mode blocks form submission and JavaScript execution.

### 8d. Safe mode enforcement

Try to get Copilot to execute JavaScript:
```
Run this JavaScript on the page: document.title
```

Copilot should not be able to call `browser_evaluate` (it's in the denylist). It will tell you it can't execute scripts in the current configuration.

---

## 9. Test: Meta-Tools (Copilot Self-Diagnosis)

This is the magic feature. Ask Copilot about connection health directly:

```
What connections do you have? Are they all working?
```
```
Why can't you access Jira?
```
```
What tools do you have available right now?
```

Copilot will call `get_connection_health` and `get_available_tools` (registered on the gateway) and give you a real answer based on actual connection state — not a hallucinated one.

---

## 10. Test: Advanced Diagnostics

Right-click any connection → **Open Diagnostics**.

The diagnostics panel shows:
- **Assistant summary** — what Copilot reads when asked about this connection
- **Tool counts** — visible and hidden
- **Last error** — if the server crashed, what the error was
- **Recent logs** — last 50 lines from the server's stderr
- **Environment** — sanitized env vars (no secrets)

This is the "advanced" view. Normal users shouldn't need it. It's for debugging and for the rare case where someone needs to understand why a connection isn't working.

---

## 11. Gateway Standalone Smoke Test

You can test the gateway independently without launching the full extension:

```bash
TOKEN="mytoken"
GATEWAY_AUTH_TOKEN="$TOKEN" node packages/gateway/dist/index.js &
# Note the port from: GATEWAY_READY port=XXXXX
PORT=XXXXX

# Health check
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:$PORT/control/status

# MCP initialize
SID=$(curl -s -D- \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}' \
  http://127.0.0.1:$PORT/mcp | tr -d '\r' | sed -n 's/^mcp-session-id: //p')

# List tools (expect get_connection_health + get_available_tools)
curl -s \
  -H "Authorization: Bearer $TOKEN" \
  -H "mcp-session-id: $SID" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  http://127.0.0.1:$PORT/mcp | grep -o '"name":"[^"]*"'
```

Expected output:
```
"name":"get_connection_health"
"name":"get_available_tools"
```

---

## 12. Common Issues

| Problem | Likely cause | Fix |
|---|---|---|
| Connections panel doesn't appear | Extension didn't activate | Check **Output → Managed Connections — Gateway** for errors |
| "Gateway failed to start" toast | Node.js not in PATH, or dist not built | Run `npm run build`, check Node.js ≥ 20 |
| GitHub shows "Needs sign-in" forever | VS Code GitHub auth not set up | Sign into GitHub via the Accounts icon (bottom-left of VS Code) |
| Atlassian "Setup needed" after install | npx cache not updated | Run `npx --yes @atlassian/mcp-atlassian --version` in terminal |
| Playwright tools not appearing | Safe mode denylist too broad | Check `ConnectionRegistry.ts` denylist, rebuild |
| Copilot doesn't call the tools | MCP not enabled in Copilot settings | Open Copilot Chat → gear icon → check MCP is enabled |
| VS Code says "proposed API not found" | VS Code version too old | Upgrade to 1.99+ or use VS Code Insiders |

---

## 13. Extension Output Channels

Two output channels are available in the Extension Development Host:

- **Managed Connections — Gateway**: stdout/stderr from the gateway process
- **Managed Connections** (if using LogOutputChannel): extension-level logs

Access via **View → Output** → dropdown in the top-right of the Output panel.
