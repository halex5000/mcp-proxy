/**
 * IPC contract between the VS Code extension and the gateway process.
 *
 * Transport: ONE extension-owned gateway process serves two endpoints on a
 * single multiplexed localhost HTTP server (random port announced on startup):
 *
 *   POST/GET/DELETE  /mcp        → MCP Streamable HTTP transport.
 *                                  VS Code/Copilot connects here as a client.
 *                                  Registered via vscode.McpHttpServerDefinition.
 *   *                /control/*  → Control API used by the extension for
 *                                  health, restart, configure, logs.
 *
 * Both endpoints require an Authorization: Bearer <token> header. The extension
 * generates the token and passes it to the gateway via the GATEWAY_AUTH_TOKEN
 * env var at spawn time, then supplies the same token in the McpHttpServerDefinition
 * headers and on every control request. This ensures only VS Code's registered
 * client and the owning extension can reach the gateway.
 *
 * Startup handshake:
 *   Extension spawns gateway (with GATEWAY_AUTH_TOKEN env) → gateway prints
 *   GATEWAY_READY port=XXXX on stderr → extension connects to
 *   http://127.0.0.1:XXXX for both /mcp (via VS Code) and /control/*.
 */

import type { ConnectionHealth, StructuredDiagnostics } from "./health.js";
import type { ConnectionId, GatewayConfig } from "./types.js";
import type { SimulationMode } from "./simulation.js";

// ── Endpoint paths & auth ───────────────────────────────────────────────────

/** MCP Streamable HTTP endpoint — what VS Code's McpHttpServerDefinition targets. */
export const MCP_PATH = "/mcp";

/** Prefix for all extension control-plane routes. */
export const CONTROL_PREFIX = "/control";

/** Env var the extension uses to hand the shared bearer token to the gateway. */
export const AUTH_TOKEN_ENV = "GATEWAY_AUTH_TOKEN";

export function authHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

// ── Startup announcement (stderr) ───────────────────────────────────────────

export const GATEWAY_READY_PREFIX = "GATEWAY_READY port=";

export function parseGatewayReady(line: string): number | null {
  if (!line.startsWith(GATEWAY_READY_PREFIX)) return null;
  const port = parseInt(line.slice(GATEWAY_READY_PREFIX.length), 10);
  return isNaN(port) ? null : port;
}

export function formatGatewayReady(port: number): string {
  return `${GATEWAY_READY_PREFIX}${port}`;
}

// ── Control API: GET /status ────────────────────────────────────────────────

export interface GatewayStatusResponse {
  version: string;
  pid: number;
  uptimeMs: number;
  connections: ConnectionStatusEntry[];
}

export interface ConnectionStatusEntry {
  id: ConnectionId;
  name: string;
  health: ConnectionHealth;
  tools: ToolEntry[];
}

export interface ToolEntry {
  name: string;
  publicName?: string;
  description: string;
  isVisible: boolean;  // False = hidden by denylist or safe-mode policy
  isSafe: boolean;
  hiddenReason?: string;
}

// ── Control API: GET /connections and GET /connections/:id/health ──────────

export interface ConnectionsResponse {
  connections: ConnectionStatusEntry[];
}

export interface ConnectionHealthResponse {
  id: ConnectionId;
  health: ConnectionHealth;
}

// ── Control API: POST /connections/:id/restart ──────────────────────────────

export interface RestartResponse {
  ok: boolean;
  message: string;
  health?: ConnectionHealth;
}

// ── Control API: POST /connections/:id/simulate ────────────────────────────

export interface SimulateRequest {
  mode: SimulationMode;
}

export interface SimulateResponse {
  ok: boolean;
  connectionId: ConnectionId;
  mode: SimulationMode;
  message: string;
  health?: ConnectionHealth;
}

// ── Control API: GET /connections/:id/diagnostics ──────────────────────────

export type DiagnosticsResponse = StructuredDiagnostics;

export interface GatewayDiagnosticsResponse {
  version: string;
  pid: number;
  uptimeMs: number;
  connections: Array<{
    id: ConnectionId;
    name: string;
    health: ConnectionHealth;
    diagnostics?: StructuredDiagnostics;
  }>;
}

// ── Control API: POST /configure ────────────────────────────────────────────
// Sent by extension when config changes (auth token refresh, settings update)

export type ConfigureRequest = GatewayConfig;

export interface ConfigureResponse {
  ok: boolean;
  errors: string[];
}

// ── Control API: GET /connections/:id/logs ──────────────────────────────────

export interface LogsResponse {
  connectionId: ConnectionId;
  lines: LogLine[];
}

export interface GatewayLogsResponse {
  lines: Array<LogLine & { connectionId: ConnectionId }>;
}

export interface LogLine {
  ts: number;   // Unix ms
  level: "stdout" | "stderr";
  text: string;
}
