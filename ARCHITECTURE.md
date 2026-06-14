# Managed MCP Connections — Architecture

**Product principle: MCP is infrastructure, not UX. Users connect capabilities, not manage servers.**

---

## 1. The Core Problem

MCP servers unlock real value with GitHub Copilot — but asking non-technical users to edit `mcp.json`, debug auth flows, restart servers, or understand process state is a guaranteed frustration factory.

The goal: make MCP feel like invisible infrastructure. The user-facing model is **Connections**, not MCP servers.

---

## 2. Architecture Decision: Gateway vs. Direct Registration

**Decision: Gateway from day one, but start thin.**

### Option A — Direct Registration
Register each managed server individually via `vscode.lm.registerMcpServerDefinitionProvider`. VS Code manages each process.

**Pros:** Simple, fewer moving parts, VS Code handles process lifecycle.

**Cons:** No centralized control plane. Can't intercept/filter tools. Each server fails independently with no unified health surface. Harder to normalize errors. Refactoring to a gateway later requires changing the MCP server identity Copilot sees (session disruption).

### Option B — Gateway (chosen)
Register ONE thin MCP proxy as the single VS Code MCP endpoint. The gateway internally manages all downstream server processes. VS Code/Copilot sees one server; we see everything.

**Pros:**
- Single control plane (HTTP control API) for health, restart, diagnostics
- Unified tool namespace across all connections
- Tool safety filtering in one place (deny unsafe tools by default)
- Hot-reload downstream server configs without disrupting the Copilot session
- The gateway itself exposes meta-tools (`get_connection_health`) that let Copilot diagnose its own problems
- Path to future features: tool proxying, rate limiting, audit logging, org-level policy enforcement

**Cons:** More upfront complexity. Single point of failure (mitigated: gateway auto-restarts, VS Code reconnects). Requires bundling gateway binary with extension.

**Why now:** The gateway is the product boundary. Everything above it is UX; everything below it is infrastructure. Building it later means disrupting the Copilot session identity and throwing away control-plane design work.

### The Hybrid Detail
- **Local stdio servers** (Playwright, local knowledge): Gateway proxies fully — it starts the process, connects an MCP client, and forwards tool calls.
- **Remote HTTP servers** (GitHub remote MCP, Atlassian): Registered via URL through the same gateway server, or detected from VS Code auth state. For MVP, GitHub remote MCP can be registered directly with an auth token; the gateway still tracks its health.

---

## 3. Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│  VS Code / GitHub Copilot Chat                              │
└──────────────────────────┬──────────────────────────────────┘
                           │ MCP stdio protocol
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Gateway Process  (Node.js, bundled with extension)         │
│                                                             │
│  ┌───────────────┐    ┌─────────────────────────────────┐  │
│  │  MCP Server   │    │  HTTP Control API :PORT         │  │
│  │  (stdio, to   │    │  GET  /status                   │  │
│  │   VS Code)    │    │  POST /configure                │  │
│  │               │    │  POST /connections/:id/restart  │  │
│  │  Tools:       │    │  GET  /connections/:id/logs     │  │
│  │  github__*    │    │  GET  /connections/:id/diag..  │  │
│  │  jira__*      │    └────────────▲────────────────────┘  │
│  │  browser__*   │                 │ HTTP                   │
│  │  get_health   │    ┌────────────┴────────────────────┐  │
│  └───────┬───────┘    │  Supervisor                     │  │
│          │ MCP client │  Manages child processes        │  │
│          ▼            │  Auto-restart with backoff      │  │
│  ┌──────────────────────────────────────────────────┐   │  │
│  │  McpProxy ×N  (one per local connection)         │   │  │
│  │  ToolFilter   (hide unsafe tools by default)     │   │  │
│  │  HealthAggregator (compute per-connection state) │   │  │
│  └──────────────────────────────────────────────────┘   │  │
│                           │                              │  │
│               ┌───────────┴──────────────┐              │  │
│               │ MCP stdio                │              │  │
│               ▼                          ▼              │  │
│     ┌──────────────────┐      ┌─────────────────┐      │  │
│     │ local-knowledge  │      │ playwright       │      │  │
│     │ (npx @mcp/fs)    │      │ (npx @pw/mcp)   │      │  │
│     └──────────────────┘      └─────────────────┘      │  │
└─────────────────────────────────────────────────────────────┘
                 ▲                         ▲
                 │ HTTP (control only)     │ Port announced via stderr
                 │
┌─────────────────────────────────────────────────────────────┐
│  VS Code Extension (extension host process)                 │
│                                                             │
│  GatewayProcess     — spawns gateway, reads port from stderr│
│  GatewayClient      — HTTP client for control API           │
│  ConnectionManager  — reads VS Code settings + auth sessions│
│                       pushes GatewayConfig on change        │
│  ManagedMcpProvider — registerMcpServerDefinitionProvider   │
│  HealthMonitor      — polls /status every 5s                │
│  ConnectionsTreeProvider — tree view, driven by health      │
│  DiagnosticsPanel   — webview, advanced diagnostic output   │
│  Commands           — refresh, restart, sign-in, diagnose   │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. TypeScript File/Folder Structure

```
mcp-proxy/
├── package.json                         # npm workspace root
├── ARCHITECTURE.md                      # This file
│
├── packages/
│   ├── shared/                          # Types shared by extension + gateway
│   │   └── src/
│   │       ├── health.ts                # Health model: states, actions, messages
│   │       ├── ipc.ts                   # Control API request/response types
│   │       ├── types.ts                 # ConnectionDefinition, GatewayConfig
│   │       └── index.ts
│   │
│   ├── gateway/                         # Gateway process (MCP stdio + HTTP control)
│   │   └── src/
│   │       ├── index.ts                 # Entry point: start control API + MCP server
│   │       ├── GatewayServer.ts         # MCP server VS Code connects to
│   │       ├── ControlServer.ts         # Express HTTP control API
│   │       ├── supervisor/
│   │       │   ├── Supervisor.ts        # Manages downstream process lifecycle
│   │       │   └── ManagedProcess.ts    # Single process wrapper with logs + events
│   │       ├── proxy/
│   │       │   ├── McpProxy.ts          # MCP client connecting to a downstream server
│   │       │   └── ToolFilter.ts        # Hides unsafe tools, enforces allowlist/denylist
│   │       └── health/
│   │           └── HealthAggregator.ts  # Builds ConnectionHealth from process state
│   │
│   └── extension/                       # VS Code extension
│       └── src/
│           ├── extension.ts             # activate() — wires everything together
│           ├── connections/
│           │   ├── ConnectionRegistry.ts # Built-in connection definitions
│           │   └── ConnectionManager.ts  # Reads settings + auth, pushes to gateway
│           ├── gateway/
│           │   ├── GatewayProcess.ts    # Spawns and manages the gateway child process
│           │   └── GatewayClient.ts     # HTTP client for the gateway control API
│           ├── health/
│           │   └── HealthMonitor.ts     # Polls gateway, fires change events
│           ├── providers/
│           │   ├── ManagedMcpProvider.ts       # McpServerDefinitionProvider
│           │   └── ConnectionsTreeProvider.ts  # TreeDataProvider for sidebar
│           ├── commands/
│           │   └── registerCommands.ts  # All command handlers
│           └── ui/
│               └── DiagnosticsPanel.ts  # Webview panel: logs, errors, env
```

---

## 5. package.json Contribution Points

```json
{
  "contributes": {
    "mcpServerDefinitionProviders": [
      { "id": "managed-connections", "label": "Managed Connections" }
    ],
    "viewsContainers": {
      "activitybar": [
        { "id": "managedConnections", "title": "Connections", "icon": "..." }
      ]
    },
    "views": {
      "managedConnections": [
        {
          "id": "managedConnections.connectionsView",
          "name": "Connections"
        }
      ]
    },
    "commands": [
      { "command": "managedConnections.refresh",          "icon": "$(refresh)" },
      { "command": "managedConnections.restart",          "icon": "$(debug-restart)" },
      { "command": "managedConnections.openDiagnostics",  "icon": "$(output)" },
      { "command": "managedConnections.signIn",           "icon": "$(key)" },
      { "command": "managedConnections.signOut",          "icon": "$(sign-out)" },
      { "command": "managedConnections.openSettings",     "icon": "$(settings-gear)" },
      { "command": "managedConnections.enableConnection",  "icon": "$(check)" },
      { "command": "managedConnections.disableConnection", "icon": "$(circle-slash)" },
      { "command": "managedConnections.installDependency", "icon": "$(cloud-download)" },
      { "command": "managedConnections.resetConnectionState" }
    ],
    "menus": {
      "view/item/context": [
        {
          "command": "managedConnections.restart",
          "when": "viewItem == connection-crashed || viewItem == connection-degraded",
          "group": "inline"
        },
        {
          "command": "managedConnections.signIn",
          "when": "viewItem == connection-auth_required",
          "group": "inline"
        }
      ]
    }
  }
}
```

---

## 6. Extension Activation Code (Key Pattern)

```typescript
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Spawn gateway, wait for port announcement on stderr
  const gatewayProcess = new GatewayProcess(context);
  const port = await gatewayProcess.start();

  // VS Code connects to the gateway (one entry point for all connections)
  const mcpProvider = new ManagedMcpProvider(gatewayProcess);
  context.subscriptions.push(
    vscode.lm.registerMcpServerDefinitionProvider(
      { id: "managed-connections" },
      mcpProvider
    )
  );

  // Push config (settings + auth tokens) to gateway
  const connectionManager = new ConnectionManager(new GatewayClient(port), context);
  await connectionManager.pushConfig();

  // Poll health and drive the UI
  const healthMonitor = new HealthMonitor(new GatewayClient(port));
  healthMonitor.start();
}
```

---

## 7. Health Model

Every connection is always in exactly one health state. States drive:
- The icon shown in the tree view
- The user-facing message
- Which action buttons are available
- What the assistant reports when asked about connection problems

```typescript
type ConnectionHealthStatus =
  | "ready"              // Connected, all tools available
  | "starting"           // Process launching
  | "stopping"           // Graceful shutdown
  | "not_configured"     // Missing required config
  | "auth_required"      // Config present, token missing/expired
  | "degraded"           // Running, subset of tools failing
  | "crashed"            // Process exited unexpectedly
  | "dependency_missing" // Required binary not installed
  | "blocked_by_policy"  // Admin/org policy prevents connection
  | "version_mismatch"   // Server version incompatible
  | "unsafe_disabled";   // Off by default (code execution)
```

State transitions:

```
not_configured ──► starting ──► running/ready
                              └► crashed (auto-retry with backoff)
auth_required ──► (user signs in) ──► starting ──► ready
dependency_missing ──► (user installs) ──► starting ──► ready
blocked_by_policy ──► (admin changes policy) ──► starting ──► ready
unsafe_disabled ──► (user enables in settings) ──► starting ──► ready
ready ──► degraded (subset of tools failing)
ready ──► crashed (process exit)
```

The health object also carries `assistantSummary`: a plain-English description
that Copilot can read via the `get_connection_health` meta-tool and relay to users.

---

## 8. Gateway/Supervisor Design

The gateway is a Node.js binary bundled with the extension. It runs as a child
process spawned by the extension host.

**Two interfaces:**

1. **MCP stdio** (to VS Code): The gateway speaks MCP protocol on stdin/stdout.
   VS Code connects here for all tool calls. The gateway aggregates tools from
   all downstream servers under a unified namespace.

2. **HTTP control API** (to the extension, localhost only): The extension uses
   this for health polling, restart commands, diagnostics retrieval, and
   configuration pushes.

**Port announcement:** Gateway writes `GATEWAY_READY port=XXXX` to stderr.
The extension reads this line to know where the control API is.

**Process supervision:**
- Each downstream local server runs as a child of the gateway process
- Auto-restart on crash with exponential backoff (1s, 2s, 5s, 15s, 30s)
- Rolling log buffer (last 200 lines per server, newest-first in diagnostics)
- Crash count tracked; surface in health + diagnostics

**Tool safety:**
- `ToolFilter` blocks tools matching unsafe patterns (code execution, arbitrary shell, destructive file ops)
- Per-connection `allowlist` (only expose these) and `denylist` (always hide these)
- Connections marked `safeByDefault: false` (e.g., Playwright) require explicit user opt-in
- `get_connection_health` and `get_available_tools` are always available — meta-tools for Copilot self-diagnosis

**What the gateway does NOT do (phase 1):**
- OAuth token refresh (the extension handles this via VS Code auth sessions)
- Rate limiting (future)
- Audit logging (future)
- Schema validation of tool arguments (future)

---

## 9. MVP Cut — What to Build First

**One managed local connection + real health + restart + diagnostics**

### Scope
- Connection: `local-knowledge` (npx @modelcontextprotocol/server-filesystem)
- Gateway spawns the server, connects proxy, surfaces tools
- Connections tree view: shows ready/crashed/starting with correct icon
- Restart button works from the tree view
- Diagnostics panel: shows recent logs and last error
- `get_connection_health` meta-tool: Copilot can explain connection state
- No mcp.json editing required

### Not in MVP
- GitHub remote MCP detection/status
- Atlassian OAuth flow
- Playwright (unsafe, requires explicit enable)
- Admin policy detection
- Dependency auto-install

### Success criteria
1. User opens VS Code, sees "Project Knowledge — Connected" in sidebar
2. Server crashes → user sees "Crashed" icon → clicks Restart → sees "Starting…" → sees "Connected"
3. User asks Copilot "why can't you read my files?" → Copilot calls `get_connection_health` → gives useful answer
4. No mcp.json, no JSON editing, no manual process management

---

## 10. Next-Phase Plan

### Phase 2: GitHub + Remote MCP Health
- Detect GitHub auth session in VS Code
- Register GitHub remote MCP URL via `SseMcpServerDefinition` (or `HttpMcpServerDefinition`)
- Show real auth state (signed in / needs sign-in)
- `managedConnections.signIn` triggers `vscode.authentication.getSession("github", ...)`
- Health: `ready` when session active, `auth_required` when not

### Phase 3: Atlassian (Jira + Confluence)
- Settings UI for Atlassian base URL
- Atlassian OAuth via `vscode.env.openExternal` + local redirect server
- Store token in `context.secrets`
- Show `auth_required` until OAuth complete
- One-click "Sign in to Jira" from Connections panel

### Phase 4: Playwright (Browser Automation)
- Off by default (`requiresExplicitEnable: true`)
- User must add `"playwright"` to `managedConnections.enabledConnections`
- Safe mode (default): `denylist` blocks JS execution, form submission
- Unsafe mode: explicit second confirmation before enabling
- Dependency check: `npx @playwright/mcp --version` → offer to install if missing

### Phase 5: Policy + Admin Controls
- Detect VS Code workspace policy file (`.vscode/mcp-policy.json`)
- Respect org-level disabled connections from VS Code Device Management
- `blocked_by_policy` state with "Contact Admin" action
- Extension manifest declares policy capabilities

### Phase 6: Graceful Degradation
- If MCP entirely unavailable (Copilot plan, Enterprise block): surface clear message
- `vscode.lm.registerMcpServerDefinitionProvider` gracefully returns empty list
- Connections panel shows informational "MCP not available in this environment" state

---

## 11. Product UX — Connections Panel

### Normal State (everything working)

```
CONNECTIONS
  ✓ Project Knowledge    Connected
    7 tools available
  ✓ GitHub               Connected
    23 tools available
  ○ Jira & Confluence    Not set up
  ○ Browser Automation   Disabled (safe mode)
```

### Problem States

**Crashed:**
```
  ✕ Project Knowledge    Crashed
    [Restart] [Diagnostics]
    "Something went wrong. Click Restart to try again."
```

**Needs auth:**
```
  🔑 GitHub              Needs sign-in
    [Sign In]
    "Sign in to continue using GitHub tools."
```

**Dependency missing:**
```
  ↓ Browser Automation   Setup needed
    [Install] [Learn more]
    "Node.js is required. Click Install to set it up."
```

**Blocked by policy:**
```
  🔒 Jira & Confluence   Blocked
    [Contact Admin] [Diagnostics]
    "Your organization's settings are preventing this connection."
```

### User Messages by Situation
| What happened | What users see | Available actions |
|---|---|---|
| Server crashed | "Something went wrong. Click Restart to try again." | Restart, Diagnostics |
| Auth expired | "Sign in to continue using this connection." | Sign In |
| Not configured | "This connection needs to be set up before it can be used." | Open Settings |
| Dependency missing | "A required tool needs to be installed first." | Install, Diagnostics |
| Policy blocked | "Your organization's settings are preventing this connection." | Contact Admin, Diagnostics |
| Unsafe disabled | "Disabled by default because it can run code. Enable in Settings." | Enable, Diagnostics |
| Starting | "Getting ready — this usually takes a few seconds." | (none) |

### Advanced Diagnostics Panel
Opened via "Open Diagnostics" — users should rarely need this.

Contents:
- **Plain-language summary** (same text the assistant reads)
- **Status table**: tool count, hidden tool count, crash count, server version, runtime version
- **Last error** (if any)
- **Recent logs** (last 50 lines, stderr highlighted in red)
- **Environment** (sanitized — no auth tokens, just keys like `ATLASSIAN_BASE_URL`)

### How the Assistant Explains Connection Problems

When a user asks "Why can't you access Jira?" or "Why did the browser tool stop working?", the assistant:

1. Calls `get_connection_health` (or `get_connection_health { connectionId: "atlassian" }`)
2. Reads `assistantSummary` from the response
3. Relays the explanation and suggests the available action

Example exchange:
> **User:** Why can't you search Jira issues?
> **Copilot:** (calls `get_connection_health`)
> **Copilot:** The Jira connection needs you to sign in. Click "Sign In" in the Connections panel, or tell me and I'll guide you through it.

This works because the gateway exposes real health state as a first-class MCP tool — the assistant is self-diagnosing, not guessing.

---

## 12. Implementation Risks

### VS Code API Maturity
`vscode.lm.registerMcpServerDefinitionProvider` and the `McpServerDefinition` types are proposed/preview APIs (as of VS Code 1.99). Breaking changes are possible. Mitigation: pin the `@types/vscode` version; test against VS Code Insiders early; feature-flag anything that touches the MCP API surface.

### How Copilot Actually Uses Registered MCP Servers
The exact mechanism by which Copilot discovers tools from registered MCP servers is still being documented. Specifically:
- Does Copilot enumerate all tools at session start, or lazily?
- Does reconnecting the MCP server (due to a gateway restart) disrupt an active chat?
- Are meta-tools like `get_connection_health` called automatically or only when explicitly mentioned?

Mitigation: Build the spike first and test empirically. The gateway pattern insulates us — VS Code only sees one MCP endpoint, so restart behavior is isolated to the gateway restart, not individual server restarts.

### OAuth Edge Cases
- GitHub token expiry mid-session: VS Code auth sessions don't push refresh events reliably. Mitigation: health monitor detects `auth_required` from 401 responses on tool calls; surfaces sign-in prompt proactively.
- Atlassian tokens are manual (no VS Code auth provider). Mitigation: use `context.secrets` for storage; guide users through the API token flow (simpler than full OAuth for initial implementation).
- Multi-account scenarios (two GitHub accounts): VS Code auth disambiguates via session scope; pick the session matching the active workspace remote URL.

### Process Supervision Reliability
- Windows: `SIGTERM` is not supported; must use `proc.kill()` which is `SIGKILL`. Handle in `ManagedProcess.stop()`.
- macOS Gatekeeper: unsigned binaries spawned from extensions may trigger security prompts. Mitigation: ship the gateway as a bundled Node.js script (not a binary), run via `process.execPath` (the VS Code Node.js runtime).
- Process cleanup on extension crash: gateway process may orphan. Mitigation: gateway exits when its stdin closes (VS Code closes it on extension deactivation); also implement a heartbeat timeout.

### Cross-Platform Packaging
- The gateway must bundle all its npm dependencies (including `@modelcontextprotocol/sdk`) into the VSIX. Use `esbuild` to bundle the gateway into a single `dist/gateway/index.js`.
- `node_modules` must not be in the VSIX. Add to `.vscodeignore`.
- Platform-specific binaries (Playwright browser binaries): these cannot be bundled. Gate behind `dependency_missing` state; offer to install into the user's local npm cache.

### Security and Sandboxing
- The control API only accepts localhost connections — enforced in `ControlServer.ts`.
- Auth tokens in `GatewayConfig` are passed in memory (process args are visible in `ps`). Mitigation: pass tokens via environment variables, not args; rotate frequently.
- Tool `denylist` is a defense-in-depth measure, not a security boundary — a compromised downstream server could still exfiltrate data through allowed tools.
- Users who enable unsafe connections accept that the extension can execute arbitrary code. Make this explicit in the enable flow.

### Tool Permission/Trust Model
- VS Code may prompt users to trust MCP tools before first use. The gateway appearing as a single "Managed Connections" server means the trust prompt is one click, not N clicks.
- Tool names are namespaced (e.g., `github__create_issue`) — collision-safe across connections.
- Future: emit a VS Code `McpServerCapabilities` declaration with explicit permission scopes per tool.

### Local Binary/Dependency Management
- `npx -y <package>` on first run will prompt in some environments (corporate proxies, offline). The `dependency_missing` state catches this.
- Offer an in-extension "Install" button that runs the install command in a VS Code terminal (visible to the user, not hidden).
- Never auto-install without user acknowledgment.

---

## 13. The Smallest Useful Spike

**Goal:** Prove the extension can register a managed MCP server, the gateway can report health, and the UI can show connection state. All in ~200 lines of real code.

### What to build

1. **Gateway** (50 lines): Start MCP stdio server + HTTP control API on random port. Announce port on stderr. Expose `/status` with hardcoded health. Expose `get_connection_health` meta-tool.

2. **Extension** (100 lines): Spawn gateway. Read port from stderr. Register gateway as `McpServerDefinitionProvider`. Show health in Output Channel. Add one command: `managedConnections.showStatus`.

3. **Tree view** (50 lines): Single item: "Gateway — Connected" or "Gateway — Starting".

### What this proves
- `vscode.lm.registerMcpServerDefinitionProvider` accepts our gateway definition
- Copilot can enumerate and call tools from the gateway
- `get_connection_health` is callable from Copilot chat
- The control API HTTP channel is stable and fast enough for 5s polling
- Process lifecycle (spawn → announce → connect → stop) works on Mac/Windows/Linux

### Spike success test
Open Copilot Chat and type:
> "What connections do you have? Can you check if they're healthy?"

Expected: Copilot calls `get_connection_health`, reads the response, and says "The gateway is connected with 2 tools available."

If this works, the architecture is proven.

---

## Open Questions

1. **MCP session continuity**: When the gateway restarts (e.g., after a crash), does VS Code automatically reconnect the MCP session, or does the user need to reload the window? If reload is required, we need to minimize gateway restarts and add a "Reconnect without reload" path.

2. **Copilot tool discovery timing**: Are tools discovered once at session start (requiring gateway restart to pick up new tools), or are they re-enumerated on demand? This affects how we handle mid-session connection state changes.

3. **GitHub Copilot remote MCP**: Is the GitHub remote MCP endpoint (`api.githubcopilot.com/mcp/`) already available to Copilot when the user is signed in? If so, we may not need to register it via our extension — we'd only need to detect and surface its health state.

4. **VS Code MCP API for remote servers**: Does `vscode.lm.registerMcpServerDefinitionProvider` support registering remote HTTP/SSE MCP servers, or is that handled differently (e.g., via `mcp.json` only)? The spike will answer this empirically.

5. **Extension activation timing**: `onStartupFinished` may be too early for some environments (slow machines, remote containers). Should we delay gateway startup until Copilot first attempts a tool call?

6. **Gateway process identity**: The extension spawns a control-API gateway AND VS Code spawns a separate MCP-stdio gateway from the same binary. These are two processes of the same code. Should they be the same process (via an IPC channel from extension to VS Code's managed process) or stay separate? A unified process would be cleaner but requires VS Code to expose the MCP process handle.
