import {
  authHeader,
  CONTROL_PREFIX,
} from "@mcp-proxy/shared";
import type {
  GatewayStatusResponse,
  RestartResponse,
  DiagnosticsResponse,
  LogsResponse,
  ConfigureRequest,
  ConfigureResponse,
  SimulateResponse,
  SimulationMode,
} from "@mcp-proxy/shared";
import type { ConnectionId } from "@mcp-proxy/shared";

/**
 * GatewayClient is the HTTP client for the gateway control plane.
 * It speaks to the /control routes on the single gateway process, authenticating
 * with the shared bearer token the extension passed to the gateway at spawn.
 */
export class GatewayClient {
  private baseUrl: string;
  private token: string;

  constructor(port: number, token: string) {
    this.baseUrl = `http://127.0.0.1:${port}${CONTROL_PREFIX}`;
    this.token = token;
  }

  async getStatus(): Promise<GatewayStatusResponse> {
    return this.get<GatewayStatusResponse>("/status");
  }

  async configure(config: ConfigureRequest): Promise<ConfigureResponse> {
    return this.post<ConfigureResponse>("/configure", config);
  }

  async restart(id: ConnectionId): Promise<RestartResponse> {
    return this.post<RestartResponse>(`/connections/${id}/restart`, {});
  }

  async simulate(id: ConnectionId, mode: SimulationMode): Promise<SimulateResponse> {
    return this.post<SimulateResponse>(`/connections/${id}/simulate`, { mode });
  }

  async getDiagnostics(id: ConnectionId): Promise<DiagnosticsResponse> {
    return this.get<DiagnosticsResponse>(`/connections/${id}/diagnostics`);
  }

  async getLogs(id: ConnectionId): Promise<LogsResponse> {
    return this.get<LogsResponse>(`/connections/${id}/logs`);
  }

  private async get<T>(path: string): Promise<T> {
    const response = await fetch(this.baseUrl + path, {
      headers: { ...authHeader(this.token) },
    });
    if (!response.ok) {
      throw new Error(`GET ${path} returned ${response.status}`);
    }
    return response.json() as Promise<T>;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(this.baseUrl + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader(this.token) },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`POST ${path} returned ${response.status}`);
    }
    return response.json() as Promise<T>;
  }
}
