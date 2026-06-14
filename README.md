# mcp-proxy

**Managed MCP Connections for VS Code**

A VS Code extension that connects GitHub Copilot to your tools — GitHub, Jira, Confluence, browser automation, local project knowledge, and more — without requiring users to touch a config file, understand MCP servers, or debug auth flows.

**Product principle: MCP is infrastructure, not UX. Users connect capabilities, not manage servers.**

---

## What Is This?

[MCP (Model Context Protocol)](https://modelcontextprotocol.io/) lets AI assistants like GitHub Copilot talk to external tools: your GitHub repos, Jira tickets, databases, browsers, internal docs. The problem: setting up MCP normally means editing JSON config files, managing Node.js processes, and debugging cryptic auth errors. That works for developers. It does not work for the people we actually want to empower.

This project is a **managed MCP infrastructure layer** — a VS Code extension that does all of that automatically, behind a friendly "Connections" panel that any user can understand.

What users see:

```
CONNECTIONS
  ✓ Project Knowledge     Connected
  ✓ GitHub                Connected  
  🔑 Jira & Confluence    Needs sign-in
  ○ Browser Automation    Not set up
```

What users never see: `mcp.json`, JSON parse errors, process IDs, port numbers, OAuth redirect flows, `npx` commands, or any MCP implementation detail.

---

## Architecture: The Key Insight

The standard MCP setup asks VS Code to manage each server independently. We don't do that.

Instead, we register a **single local gateway process** as the one MCP endpoint VS Code/Copilot sees. That gateway manages everything else:

```
VS Code / GitHub Copilot Chat
        │
        │  HTTP (MCP Streamable HTTP transport)
        │  McpHttpServerDefinition → http://127.0.0.1:<port>/mcp
        ▼
┌─────────────────────────────────────────────────┐
│  Gateway Process  (single Node.js process,      │
│  owned and monitored by the VS Code extension)  │
│                                                 │
│  POST /mcp          → MCP tools to Copilot      │
│  /control/*         → health, restart, config   │
│                                                 │
│  Tools exposed:                                 │
│    github__create_issue                         │
│    jira__search_tickets                         │
│    browser__navigate                            │
│    get_connection_health   ← Copilot meta-tool  │
│    get_available_tools     ← Copilot meta-tool  │
│                                                 │
│  Downstream (MCP stdio):                        │
│    ├── local-knowledge  (npx @mcp/filesystem)   │
│    └── playwright       (npx @playwright/mcp)   │
└─────────────────────────────────────────────────┘
        │
        │  HTTP (control plane, extension only)
        │  Bearer-token authenticated
        ▼
VS Code Extension (extension host process)
  GatewayProcess     — spawns gateway, reads port from stderr
  GatewayClient      — talks to /control/* for health + config
  ConnectionManager  — assembles config from VS Code settings + auth
  ManagedMcpProvider — registers the gateway as McpHttpServerDefinition
  HealthMonitor      — polls /status every 5s, fires change events
  ConnectionsTreeView — sidebar panel driven purely by health states
```

### Why a gateway instead of direct registration?

The alternative — registering each MCP server individually — means VS Code manages each process lifecycle. A crashed Jira server takes down its tools. Adding a new server changes the identity VS Code tracks. There's no central place to filter unsafe tools, normalize errors, or let Copilot introspect connection health.

The gateway gives us a single control plane. Downstream connection restarts happen *inside* the gateway — Copilot's MCP session stays up. New connections can be hot-loaded without touching the Copilot session. Tool safety filtering happens in one place. And Copilot can call `get_connection_health` when a user asks "why can't you see my Jira tickets?" and give a real answer.

### The transport choice: HTTP, not stdio

When VS Code's `registerMcpServerDefinitionProvider` gets a `McpStdioServerDefinition`, it spawns and owns that process. That means VS Code would be running one copy of the gateway while our extension runs a *second* copy for the control API — two different processes, neither monitoring the right one.

`McpHttpServerDefinition` treats VS Code as a client. We register `http://127.0.0.1:<port>/mcp`, the extension spawns exactly one gateway process, and VS Code connects to it over HTTP. One process. The extension monitors and restarts the exact instance Copilot is talking to.

---

## Package Layout

```
packages/
  shared/         Core types shared between extension and gateway:
                    health.ts      — 10 connection health states + user messages + actions
                    ipc.ts         — control API request/response types, auth helpers
                    types.ts       — ConnectionDefinition, GatewayConfig

  gateway/        The gateway process (a self-contained Node.js binary):
                    index.ts               — startup: one multiplexed Express server
                    McpHttpEndpoint.ts     — /mcp: MCP Streamable HTTP transport, session mgmt
                    GatewayServer.ts       — per-session McpServer factory + meta-tools
                    ControlServer.ts       — /control/*: health, restart, configure, logs
                    supervisor/
                      Supervisor.ts        — manages downstream process lifecycle
                      ManagedProcess.ts    — single process: spawn, restart, log buffer, events
                    proxy/
                      McpProxy.ts          — MCP client connecting to a running downstream process
                      StreamMcpTransport.ts— MCP stdio protocol over existing streams (no re-spawn)
                      ToolFilter.ts        — denylist, allowlist, unsafe-tool blocking
                    health/
                      HealthAggregator.ts  — derive ConnectionHealth from process + proxy state

  fake-mcp-server/
                  Deterministic downstream MCP fixture for tests and demos:
                    index.ts       — echo/data/marker tools + controlled failure modes

  extension/      The VS Code extension:
                    extension.ts                     — activate(): wires everything together
                    connections/
                      ConnectionRegistry.ts          — built-in connection definitions
                      ConnectionManager.ts           — reads settings + VS Code auth, pushes config
                    gateway/
                      GatewayProcess.ts              — spawns gateway, reads port, generates token
                      GatewayClient.ts               — HTTP client for /control/*
                    health/
                      HealthMonitor.ts               — polls gateway, fires onChange events
                    providers/
                      ManagedMcpProvider.ts          — McpHttpServerDefinition registration
                      ConnectionsTreeProvider.ts     — sidebar tree view
                    commands/
                      registerCommands.ts            — refresh, restart, sign-in, diagnostics, etc.
                    ui/
                      DiagnosticsPanel.ts            — webview: logs, errors, env summary
                    resources/
                      connections.svg                — Activity Bar icon for the Connections view
```

---

## Health Model

Every connection is in exactly one state. States drive the icon, the user message, the available action buttons, and the `assistantSummary` the AI reads when asked about connection problems.

| State | Icon | User sees | Available actions |
|---|---|---|---|
| `ready` | ✓ | "Connected" | Diagnostics, Disable |
| `starting` | ⟳ | "Getting ready…" | — |
| `not_configured` | ○ | "This connection needs to be set up" | Open Settings |
| `auth_required` | 🔑 | "Sign in to continue" | Sign In |
| `degraded` | ⚠ | "Connected, some features unavailable" | Restart, Diagnostics |
| `crashed` | ✕ | "Something went wrong. Click Restart." | Restart, Diagnostics |
| `dependency_missing` | ↓ | "A required tool needs to be installed" | Install, Diagnostics |
| `blocked_by_policy` | 🔒 | "Your org's settings are preventing this" | Contact Admin |
| `version_mismatch` | ↑ | "An update is needed" | Update |
| `unsafe_disabled` | ⊘ | "Disabled — can run code. Enable in Settings." | Enable |

Every state also carries an `assistantSummary` — a plain-English string the gateway exposes via the `get_connection_health` tool. When a user asks Copilot *"why can't you access Jira?"*, Copilot calls this tool and relays the answer. The AI diagnoses its own connection problems.

---

## Built-in Connections

Defined in `ConnectionRegistry.ts`. Adding a new connection here is the entire surface — the extension picks it up automatically in the tree view, health monitor, and MCP provider.

| ID | Name | Kind | Safe by default |
|---|---|---|---|
| `test-echo` | Test Echo | local stdio | ✓ |
| `local-knowledge` | Project Knowledge | local stdio | ✓ |
| `github` | GitHub | remote HTTP | ✓ |
| `atlassian` | Jira & Confluence | remote OAuth | ✓ |
| `playwright` | Browser Automation | local stdio | ✗ (explicit enable required) |

`test-echo` is enabled by default in development. It is the appliance-grade proof fixture: no network fetches, no external auth, deterministic tools, controlled crashes, and optional unsafe fixture tools that must be hidden by the gateway.

### Tool Safety

The `ToolFilter` applies three layers:
1. **Allowlist** — only expose tools matching these patterns (undefined = allow all)
2. **Denylist** — always hide tools matching these patterns
3. **Unsafe tool blocking** — patterns like `execute_code`, `run_command`, `shell_exec`, `browser_execute_script` are blocked globally by default

Connections marked `safeByDefault: false` (e.g. Playwright) require the user to explicitly add them to `managedConnections.enabledConnections` in VS Code settings before they activate.

---

## Security Model

- **Localhost only**: the gateway's Express server rejects any request not from `127.0.0.1` / `::1`.
- **Bearer token**: the extension generates a random 32-byte hex token at startup, passes it to the gateway via `GATEWAY_AUTH_TOKEN` env var, supplies it in the `McpHttpServerDefinition` headers and on every `/control` call. No external process can reach the gateway.
- **Token scope**: the token is per-extension-session (regenerated on each activate). It never touches disk.
- **No secrets in process args**: auth tokens for downstream connections are passed via environment variables, not command-line arguments.
- **Graceful shutdown**: the gateway exits when its stdin closes (VS Code deactivates the extension), preventing orphan processes.

---

## VS Code API Notes

- **`vscode.lm.registerMcpServerDefinitionProvider(id: string, provider)`** — the registration call. The `id` string must match `contributes.mcpServerDefinitionProviders[].id` in `package.json`.
- **`McpHttpServerDefinition(label, uri, headers?, version?)`** — VS Code connects as an HTTP client; it does **not** spawn the process. This is what makes the single-process design work.
- **`resolveMcpServerDefinition`** — called by VS Code when it's about to start/connect the server. This is where interactive auth would go; for the local gateway, we return the definition unchanged (downstream auth is handled by the extension pushing tokens over `/control/configure`).
- **First-run caveat**: VS Code does not autostart programmatically-registered MCP servers on first install — tools are cached after the first manual start, then autostart works on subsequent launches. The extension needs to guide the user through this once.

---

## Development

### Prerequisites
- Node.js ≥ 20
- VS Code ≥ 1.99 (for the MCP provider APIs)

### Setup
```bash
npm install
npm run build
```

### Proof ladder

```bash
npm run smoke
npm test
npm run test:extension-ui
npm run test:vscode
```

`npm run smoke` boots the gateway, configures `test-echo`, verifies `/control/status`, initializes MCP over HTTP, lists tools, invokes echo, proves unsafe tool filtering, simulates a downstream crash, and recovers with Restart.

`npm test` adds unit coverage for health state normalization, tool filtering, Connections panel presentation, command rules, and the gateway integration path.

`npm run test:extension-ui` runs only the pure Connections panel and command-rule tests. These verify all required user-facing states without launching VS Code.

`npm run test:vscode` launches a real Extension Development Host using `@vscode/test-electron`, activates the extension, verifies command contributions, and runs gateway-backed commands against the `Test Echo` fixture. Set `VSCODE_TEST_EXECUTABLE=/path/to/Code` to reuse a local VS Code build instead of downloading one.

Manual proof docs:

- [LOCAL_RUN.md](LOCAL_RUN.md)
- [SMOKE_TEST.md](SMOKE_TEST.md)
- [COPILOT_REALITY_TEST.md](COPILOT_REALITY_TEST.md)
- [SLAY_TEST.md](SLAY_TEST.md)
- [TOOL_FILTERING_TEST.md](TOOL_FILTERING_TEST.md)
- [CHAOS_TEST.md](CHAOS_TEST.md)
- [EXTENSION_UI_TEST.md](EXTENSION_UI_TEST.md)
- [ASSISTANT_DIAGNOSTICS_TEST.md](ASSISTANT_DIAGNOSTICS_TEST.md)
- [DEMO_SCRIPT.md](DEMO_SCRIPT.md)
- [WORK_EXTENSION_INTEGRATION.md](WORK_EXTENSION_INTEGRATION.md)

### Type-check all packages
```bash
npm run typecheck
```

### Smoke-test the gateway standalone
```bash
TOKEN="mytoken"
GATEWAY_AUTH_TOKEN="$TOKEN" node packages/gateway/dist/index.js &

# Should print: GATEWAY_READY port=XXXXX

PORT=XXXXX  # from the output above

# Control API health check
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:$PORT/control/status

# MCP initialize handshake
curl -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -H "Accept: application/json, text/event-stream" \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' \
     http://127.0.0.1:$PORT/mcp

# tools/list (use the mcp-session-id from the initialize response)
curl -H "Authorization: Bearer $TOKEN" \
     -H "mcp-session-id: <sid-from-above>" \
     -H "Content-Type: application/json" \
     -H "Accept: application/json, text/event-stream" \
     -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
     http://127.0.0.1:$PORT/mcp
```

Expected `tools/list` response includes `get_connection_health` and `get_available_tools`.

---

## Roadmap

### MVP (this spike)
- [x] Single-process gateway: `/mcp` (Streamable HTTP) + `/control/*` (health API) on one port
- [x] Bearer-token auth + localhost guard
- [x] MCP session management (per-session McpServer factory)
- [x] Meta-tools: `get_connection_health`, `get_available_tools`
- [x] Supervisor with auto-restart + exponential backoff
- [x] `StreamMcpTransport` (attach to running process — no double-spawn)
- [x] Tool safety filtering (allowlist, denylist, unsafe-pattern blocking)
- [x] Health model (10 states, user messages, available actions, assistant summary)
- [x] Connections tree view (status icons, inline actions, tool counts)
- [x] Diagnostics webview (logs, last error, env summary)
- [x] Full command palette integration
- [x] VS Code `McpHttpServerDefinition` registration (not stdio)

### Phase 2: GitHub + Live Auth
- [ ] Detect GitHub VS Code auth session, inject token, register GitHub remote MCP
- [ ] Show real `auth_required` / `ready` state for GitHub
- [ ] `managedConnections.signIn` triggers `vscode.authentication.getSession`

### Phase 3: Atlassian
- [ ] Settings UI for base URL
- [ ] Atlassian API token flow via `context.secrets`
- [ ] Jira + Confluence tools

### Phase 4: Playwright
- [ ] Dependency check + guided install
- [ ] Safe-mode denylist (no JS execution, no form submission)
- [ ] Explicit enable flow with confirmation

### Phase 5: Policy + Org Controls
- [ ] Workspace policy file detection
- [ ] `blocked_by_policy` state with contact-admin guidance
- [ ] Graceful degradation when MCP unavailable in VS Code plan/edition

---

## Open Questions (tracking)

| # | Question | Status |
|---|---|---|
| 1 | Session continuity on gateway restart | **Resolved** — HTTP transport; `/mcp` stays up across downstream restarts |
| 2 | Copilot tool discovery timing | Partial — first-run requires manual start; subsequent launches autostart |
| 3 | GitHub remote MCP detection | Open |
| 4 | HTTP server definition support | **Resolved** — `McpHttpServerDefinition` confirmed, supports localhost URI |
| 5 | Extension activation timing | Open — `onStartupFinished` vs lazy start |
| 6 | Single-process gateway design | **Resolved** — HTTP definition = VS Code is a client, extension owns the process |

Full details in [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## Contributing

The connection registry (`packages/extension/src/connections/ConnectionRegistry.ts`) is the main extension point. A new connection is a `ConnectionDefinition` object with an id, name, kind, icon, safety policy, config schema, and either a command (for local stdio) or a URL + auth config (for remote). Everything else — tree view, health tracking, MCP registration — picks it up automatically.
