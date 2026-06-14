import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { MCP_PATH } from "@mcp-proxy/shared";
import type { GatewayServer } from "./GatewayServer.js";

/**
 * McpHttpEndpoint mounts the MCP Streamable HTTP transport on the shared Express
 * app at /mcp. This is the endpoint VS Code connects to via the
 * McpHttpServerDefinition the extension registers.
 *
 * Because this lives in the same process the extension spawned and monitors,
 * there is exactly one gateway process — the one Copilot talks to is the one
 * the extension manages. (This is the whole point of using an HTTP definition
 * instead of a stdio definition: VS Code is a client here, not the spawner.)
 *
 * Session handling follows the canonical MCP SDK pattern: an initialize request
 * with no session id creates a new transport (and a freshly built McpServer);
 * subsequent requests carry the mcp-session-id header and reuse it.
 */
export class McpHttpEndpoint {
  private gatewayServer: GatewayServer;
  private transports: Record<string, StreamableHTTPServerTransport> = {};

  constructor(gatewayServer: GatewayServer) {
    this.gatewayServer = gatewayServer;
  }

  mount(app: Express): void {
    app.post(MCP_PATH, (req, res) => this.handlePost(req, res));
    app.get(MCP_PATH, (req, res) => this.handleSessionRequest(req, res));
    app.delete(MCP_PATH, (req, res) => this.handleSessionRequest(req, res));
  }

  async closeAll(): Promise<void> {
    for (const transport of Object.values(this.transports)) {
      await transport.close();
    }
    this.transports = {};
  }

  private async handlePost(req: Request, res: Response): Promise<void> {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    let transport: StreamableHTTPServerTransport;

    if (sessionId && this.transports[sessionId]) {
      transport = this.transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // New session: build a fresh server with the current tool set.
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          this.transports[sid] = transport;
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          delete this.transports[transport.sessionId];
        }
      };

      const server = this.gatewayServer.buildServer();
      await server.connect(transport);
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: no valid session ID provided" },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  }

  private async handleSessionRequest(req: Request, res: Response): Promise<void> {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !this.transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await this.transports[sessionId].handleRequest(req, res);
  }
}
