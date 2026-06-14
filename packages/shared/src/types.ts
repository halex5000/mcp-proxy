/**
 * Core domain types shared between the extension and the gateway process.
 */

import type { ConnectionHealth } from "./health.js";

export type ConnectionKind =
  | "local-stdio"    // Local process, MCP over stdio
  | "remote-http"    // Remote MCP endpoint over HTTP/SSE
  | "remote-github"  // GitHub remote MCP (managed by GitHub infra)
  | "remote-oauth";  // OAuth-gated remote MCP endpoint

export type ConnectionId =
  | "local-knowledge" // Local file/workspace knowledge base
  | "github"          // GitHub (issues, PRs, repos, code search)
  | "atlassian"       // Jira + Confluence
  | "playwright"      // Browser automation (unsafe — off by default)
  | string;           // Extension point for future connections

export interface ConfigField {
  key: string;
  label: string;
  description: string;
  type: "string" | "secret" | "boolean" | "path";
  required: boolean;
  default?: string | boolean;
}

export interface OAuthConfig {
  provider: string;
  scopes: string[];
  /** VS Code auth provider ID, e.g. "github", "microsoft" */
  vsCodeAuthProviderId?: string;
  /** Manual token setting key for non-VS Code OAuth flows */
  tokenSettingKey?: string;
}

export interface DependencyCheck {
  /** Human-readable name of the thing that needs installing */
  name: string;
  /** Shell command to check existence, e.g. "node --version" */
  checkCommand: string;
  /** Minimum version string if applicable */
  minVersion?: string;
  /** What to offer to do to install it */
  installCommand?: string;
  /** npm package, if we can install it automatically */
  npmPackage?: string;
}

export interface ConnectionDefinition {
  id: ConnectionId;
  name: string;
  description: string;
  kind: ConnectionKind;
  /** VS Code product icon ID, e.g. "$(github)" */
  icon: string;
  requiredConfig: ConfigField[];
  optionalConfig: ConfigField[];

  // Local stdio servers
  command?: string;
  args?: string[];
  installCheck?: DependencyCheck;

  // Remote servers
  baseUrl?: string;
  oauthConfig?: OAuthConfig;

  // Tool safety policy
  /** Only expose tools matching these glob patterns. Undefined = allow all. */
  allowlist?: string[];
  /** Always hide tools matching these glob patterns. */
  denylist?: string[];
  /** If true, extension requires explicit user opt-in before enabling. */
  requiresExplicitEnable?: boolean;
  /** Safe to use by default without user opt-in. */
  safeByDefault: boolean;
}

// Built-in connection definitions live in packages/extension/src/connections/ConnectionRegistry.ts
// This type is what the gateway receives from the extension on startup.
export interface GatewayConfig {
  connections: ActiveConnectionConfig[];
  gatewayVersion: string;
}

export interface ActiveConnectionConfig {
  id: ConnectionId;
  definition: ConnectionDefinition;
  enabled: boolean;
  settings: Record<string, string>;
  authToken?: string;            // Injected by extension after VS Code auth
  /**
   * When set, the gateway surfaces this health state instead of computing one
   * from process/proxy state. Used by the extension to communicate states it
   * knows about but the gateway cannot observe (e.g. unsafe_disabled,
   * dependency_missing, auth_required before the process even starts).
   */
  healthOverride?: Pick<ConnectionHealth, "status" | "message" | "detail">;
}
