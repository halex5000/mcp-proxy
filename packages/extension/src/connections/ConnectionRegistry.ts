import type { ConnectionDefinition } from "@mcp-proxy/shared";

/**
 * Built-in connection definitions.
 *
 * Adding a new connection here is the complete registration surface.
 * The extension picks it up automatically in the tree view, health monitor,
 * MCP provider, and command palette. Users never touch mcp.json.
 *
 * Connection kinds:
 *   local-stdio   — gateway spawns a child process; MCP over stdio
 *   remote-github — registered directly with VS Code as McpHttpServerDefinition;
 *                   VS Code connects to GitHub's infrastructure; token from VS Code auth
 *   remote-oauth  — reserved for future remote endpoints requiring OAuth
 */
export const CONNECTION_REGISTRY: ConnectionDefinition[] = [
  // ── Test Echo ──────────────────────────────────────────────────────────────
  {
    id: "test-echo",
    name: "Test Echo",
    description:
      "Deterministic local test connection used to prove lifecycle, health, tool filtering, and Copilot visibility.",
    kind: "local-stdio",
    icon: "$(beaker)",
    safeByDefault: true,
    mode: "managed",
    requiredConfig: [],
    optionalConfig: [],
    command: "node",
    args: ["${fakeMcpServerEntrypoint}"],
    installCheck: {
      name: "Node.js",
      checkCommand: "node --version",
      minVersion: "18.0.0",
    },
  },

  // ── Local Knowledge ────────────────────────────────────────────────────────
  {
    id: "local-knowledge",
    name: "Project Knowledge",
    description:
      "Gives Copilot read-only access to your workspace files and local documentation.",
    kind: "local-stdio",
    icon: "$(book)",
    safeByDefault: true,
    mode: "managed",
    requiredConfig: [],
    optionalConfig: [
      {
        key: "knowledgePath",
        label: "Knowledge folder",
        description:
          "Path to additional markdown or text files to index (defaults to workspace root)",
        type: "path",
        required: false,
      },
    ],
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "${workspaceFolder}"],
    installCheck: {
      name: "Node.js (npx)",
      checkCommand: "node --version",
      minVersion: "18.0.0",
    },
    // Read-only: expose navigation tools, hide anything that writes
    allowlist: [
      "read_file",
      "list_directory",
      "search_files",
      "get_file_info",
      "list_allowed_directories",
    ],
    denylist: [
      "write_file",
      "create_directory",
      "move_file",
      "delete_file",
      "edit_file",
    ],
  },

  // ── GitHub ─────────────────────────────────────────────────────────────────
  {
    id: "github",
    name: "GitHub",
    description:
      "Issues, pull requests, code search, and repository management via GitHub's remote MCP.",
    kind: "remote-github",
    icon: "$(github)",
    safeByDefault: true,
    mode: "external",
    requiredConfig: [],
    optionalConfig: [],
    // GitHub remote MCP is hosted by GitHub. The extension detects the user's
    // VS Code GitHub session and injects the token in resolveMcpServerDefinition.
    baseUrl: "https://api.githubcopilot.com/mcp/",
    oauthConfig: {
      provider: "github",
      vsCodeAuthProviderId: "github",
      scopes: ["repo", "read:org", "read:user"],
    },
  },

  // ── Atlassian ──────────────────────────────────────────────────────────────
  {
    id: "atlassian",
    name: "Jira & Confluence",
    description:
      "Create issues, search docs, update tickets, and link Jira to your code.",
    kind: "local-stdio",
    icon: "$(tasklist)",
    safeByDefault: true,
    mode: "managed",
    requiredConfig: [
      {
        key: "ATLASSIAN_SITE_NAME",
        label: "Atlassian site name",
        description:
          "Your Atlassian subdomain, e.g. for yourcompany.atlassian.net enter yourcompany",
        type: "string",
        required: true,
      },
      {
        key: "ATLASSIAN_USER_EMAIL",
        label: "Email address",
        description: "The email associated with your Atlassian account",
        type: "string",
        required: true,
      },
      {
        key: "ATLASSIAN_API_TOKEN",
        label: "API token",
        description:
          "Create one at id.atlassian.com → Security → API tokens",
        type: "secret",
        required: true,
      },
    ],
    optionalConfig: [],
    command: "npx",
    args: ["-y", "@atlassian/mcp-atlassian"],
    installCheck: {
      name: "@atlassian/mcp-atlassian",
      checkCommand: "npx --yes @atlassian/mcp-atlassian --version",
      npmPackage: "@atlassian/mcp-atlassian",
    },
  },

  // ── Playwright ─────────────────────────────────────────────────────────────
  {
    id: "playwright",
    name: "Browser Automation",
    description:
      "Browse the web, take screenshots, fill forms, and extract page content. Disabled by default — can execute JavaScript.",
    kind: "local-stdio",
    icon: "$(browser)",
    safeByDefault: false,
    mode: "managed",
    requiresExplicitEnable: true,
    requiredConfig: [],
    optionalConfig: [
      {
        key: "PLAYWRIGHT_HEADLESS",
        label: "Headless browser",
        description: "Run browser in headless mode (no visible window)",
        type: "boolean",
        required: false,
        default: true,
      },
    ],
    command: "npx",
    args: ["-y", "@playwright/mcp@latest"],
    installCheck: {
      name: "@playwright/mcp",
      checkCommand: "npx --yes @playwright/mcp --version",
      npmPackage: "@playwright/mcp",
    },
    // Safe mode: read/navigate only. JS execution, form submission, and
    // dialog handling are hidden unless the user explicitly disables safe mode.
    denylist: [
      "browser_evaluate",
      "browser_execute_script",
      "browser_handle_dialog",
      "browser_type",
      "browser_fill",
      "browser_select_option",
      "browser_check",
      "browser_uncheck",
      "browser_upload_file",
      "browser_press_key",
    ],
  },
];

export function findConnection(id: string): ConnectionDefinition | undefined {
  return CONNECTION_REGISTRY.find((c) => c.id === id);
}
