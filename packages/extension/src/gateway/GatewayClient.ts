import type {
  GatewayStatusResponse,
  RestartResponse,
  DiagnosticsResponse,
  LogsResponse,
  ConfigureRequest,
  ConfigureResponse,
} from "@mcp-proxy/shared";
import type { ConnectionId } from "@mcp-proxy/shared";

/**
 * GatewayClient is the HTTP client for the gateway control API.
 * It speaks to the ControlServer running inside the gateway process.
 */
export class GatewayClient {
  private baseUrl: string;

  constructor(port: number) {
    this.baseUrl = `http://127.0.0.1:${port}`;
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

  async getDiagnostics(id: ConnectionId): Promise<DiagnosticsResponse> {
    return this.get<DiagnosticsResponse>(`/connections/${id}/diagnostics`);
  }

  async getLogs(id: ConnectionId): Promise<LogsResponse> {
    return this.get<LogsResponse>(`/connections/${id}/logs`);
  }

  private async get<T>(path: string): Promise<T> {
    const response = await fetch(this.baseUrl + path);
    if (!response.ok) {
      throw new Error(`GET ${path} returned ${response.status}`);
    }
    return response.json() as Promise<T>;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(this.baseUrl + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`POST ${path} returned ${response.status}`);
    }
    return response.json() as Promise<T>;
  }
}
