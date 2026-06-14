/**
 * IPC contract between the VS Code extension and the gateway process.
 *
 * Transport: The extension talks to the gateway over a local HTTP control
 * server (random port announced on gateway stdout at startup).
 * The gateway uses MCP stdio as the data plane to VS Code.
 *
 * Startup handshake:
 *   Extension spawns gateway → gateway prints GATEWAY_READY port=XXXX → extension
 *   connects to http://127.0.0.1:XXXX for control commands.
 */

import type { ConnectionHealth, StructuredDiagnostics } from "./health.js";
import type { ConnectionId, GatewayConfig } from "./types.js";

// ── Startup announcement (stdout) ──────────────────────────────────────────

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
  description: string;
  isVisible: boolean;  // False = hidden by denylist or safe-mode policy
  isSafe: boolean;
}

// ── Control API: POST /connections/:id/restart ──────────────────────────────

export interface RestartResponse {
  ok: boolean;
  message: string;
}

// ── Control API: GET /connections/:id/diagnostics ──────────────────────────

export type DiagnosticsResponse = StructuredDiagnostics;

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

export interface LogLine {
  ts: number;   // Unix ms
  level: "stdout" | "stderr";
  text: string;
}
