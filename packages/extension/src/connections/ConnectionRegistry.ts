import type { ConnectionDefinition } from "@mcp-proxy/shared";

/**
 * The canonical registry of all built-in connection definitions.
 *
 * Adding a new connection here is the entire surface for registering it —
 * the extension will pick it up automatically in the tree view, health monitor,
 * and MCP provider. Users never touch mcp.json.
 */
export const CONNECTION_REGISTRY: ConnectionDefinition[] = [
  {
    id: "local-knowledge",
    name: "Project Knowledge",
    description: "Gives Copilot access to your workspace files, notes, and local documentation.",
    kind: "local-stdio",
    icon: "$(book)",
    safeByDefault: true,
    requiredConfig: [],
    optionalConfig: [
      {
        key: "knowledgePath",
        label: "Knowledge folder",
        description: "Path to additional markdown or text files to index",
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
    allowlist: ["read_file", "list_directory", "search_files", "get_file_info"],
    denylist: ["write_file", "create_directory", "move_file", "delete_file"],
  },
  {
    id: "github",
    name: "GitHub",
    description: "Issues, pull requests, code search, and repository management.",
    kind: "remote-github",
    icon: "$(github)",
    safeByDefault: true,
    requiredConfig: [],
    optionalConfig: [],
    // GitHub remote MCP is served by GitHub's infrastructure.
    // The extension detects the user's GitHub session and injects the token.
    baseUrl: "https://api.githubcopilot.com/mcp/",
    oauthConfig: {
      provider: "github",
      vsCodeAuthProviderId: "github",
      scopes: ["repo", "read:org", "read:user"],
    },
  },
  {
    id: "atlassian",
    name: "Jira & Confluence",
    description: "Create issues, search docs, update tickets, and link Jira to your code.",
    kind: "remote-oauth",
    icon: "$(tasklist)",
    safeByDefault: true,
    requiredConfig: [
      {
        key: "baseUrl",
        label: "Atlassian URL",
        description: "Your Atlassian workspace URL, e.g. https://yourcompany.atlassian.net",
        type: "string",
        required: true,
      },
    ],
    optionalConfig: [],
    oauthConfig: {
      provider: "atlassian",
      scopes: ["read:jira-work", "write:jira-work", "read:confluence-content.all"],
      tokenSettingKey: "managedConnections.atlassian.token",
    },
  },
  {
    id: "playwright",
    name: "Browser Automation",
    description: "Browse the web, take screenshots, and fill forms. Disabled by default.",
    kind: "local-stdio",
    icon: "$(browser)",
    safeByDefault: false,
    requiresExplicitEnable: true,
    requiredConfig: [],
    optionalConfig: [
      {
        key: "safeMode",
        label: "Safe mode",
        description: "Restrict to read-only browsing (no form submission or script execution)",
        type: "boolean",
        required: false,
        default: true,
      },
    ],
    command: "npx",
    args: ["-y", "@playwright/mcp@latest"],
    installCheck: {
      name: "Node.js + Playwright MCP",
      checkCommand: "npx @playwright/mcp --version",
      npmPackage: "@playwright/mcp",
    },
    // In safe mode, hide dangerous tools. The extension passes safeMode as env.
    denylist: ["browser_execute_script", "browser_handle_dialog", "browser_type"],
  },
];

export function findConnection(id: string): ConnectionDefinition | undefined {
  return CONNECTION_REGISTRY.find((c) => c.id === id);
}
