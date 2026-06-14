import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { McpProxy } from "./proxy/McpProxy.js";
import type { ConnectionId } from "@mcp-proxy/shared";
import type { HealthAggregator } from "./health/HealthAggregator.js";
import type { Supervisor } from "./supervisor/Supervisor.js";

/**
 * GatewayServer builds the MCP server that VS Code connects to over the
 * Streamable HTTP transport (see McpHttpEndpoint).
 *
 * It is a *factory*: each MCP session gets a freshly built McpServer via
 * buildServer(), configured with the current set of visible proxied tools plus
 * always-available meta-tools. The proxy registry is shared and updated live;
 * tool changes are picked up the next time a session is established. (This
 * matches VS Code's behavior — programmatically registered servers cache their
 * tool list per session.)
 *
 * Tools are namespaced by connection ID (e.g. github__create_issue) to prevent
 * collisions. The meta-tools (get_connection_health, get_available_tools) let
 * Copilot diagnose connection problems and explain them to users autonomously.
 */
export class GatewayServer {
  private proxies = new Map<ConnectionId, McpProxy>();
  private healthAggregator: HealthAggregator;
  private supervisor: Supervisor;

  constructor(healthAggregator: HealthAggregator, supervisor: Supervisor) {
    this.healthAggregator = healthAggregator;
    this.supervisor = supervisor;
  }

  registerProxy(id: ConnectionId, proxy: McpProxy): void {
    this.proxies.set(id, proxy);
  }

  removeProxy(id: ConnectionId): void {
    this.proxies.delete(id);
  }

  /** Build a fresh McpServer configured with current tools. Called per session. */
  buildServer(): McpServer {
    const server = new McpServer({
      name: "mcp-gateway",
      version: "0.1.0",
    });

    this.registerMetaTools(server);
    this.registerProxiedTools(server);

    return server;
  }

  private registerProxiedTools(server: McpServer): void {
    for (const [id, proxy] of this.proxies) {
      for (const tool of proxy.tools) {
        if (!tool.isVisible) continue;

        server.tool(
          tool.publicName,
          tool.description ?? `Tool from ${id}`,
          { input: z.record(z.unknown()).optional() },
          async ({ input }) => {
            try {
              const result = await proxy.callTool(
                tool.publicName,
                (input as Record<string, unknown>) ?? {}
              );
              return {
                content: [{ type: "text", text: JSON.stringify(result) }],
              };
            } catch (err) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Error calling ${tool.publicName}: ${String(err)}`,
                  },
                ],
                isError: true,
              };
            }
          }
        );
      }
    }
  }

  /**
   * Meta-tools are always available regardless of downstream connection state.
   * They let Copilot diagnose connection problems and explain them to users.
   */
  private registerMetaTools(server: McpServer): void {
    server.tool(
      "get_connection_health",
      [
        "Returns the current health and status of all managed connections.",
        "Call this when the user asks why a tool is not working, why a connection failed,",
        "or to understand what capabilities are currently available.",
        "The response includes a plain-language summary suitable for relaying to the user.",
      ].join(" "),
      {
        connectionId: z
          .string()
          .optional()
          .describe(
            "Optional. Specific connection ID to query (e.g. 'github', 'atlassian'). Omit for all connections."
          ),
      },
      async ({ connectionId }) => {
        const results: Record<string, unknown> = {};

        for (const [id, proc] of this.supervisor.getAllProcesses()) {
          if (connectionId && id !== connectionId) continue;
          const proxy = this.proxies.get(id);
          const health = this.healthAggregator.compute(id, id, proc, proxy);
          results[id] = {
            status: health.status,
            label: health.label,
            message: health.message,
            toolCount: health.toolCount,
            actions: health.actions,
            assistantSummary: health.diagnostics?.assistantSummary ?? health.message,
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(results, null, 2),
            },
          ],
        };
      }
    );

    server.tool(
      "get_available_tools",
      [
        "Lists all tools currently available through managed connections.",
        "Use this to understand what actions are possible before attempting them.",
        "Hidden or unsafe tools are excluded from this list.",
      ].join(" "),
      {},
      async () => {
        const tools: Array<{ name: string; description: string; connection: string }> = [];

        for (const [id, proxy] of this.proxies) {
          for (const tool of proxy.tools) {
            if (!tool.isVisible) continue;
            tools.push({
              name: tool.publicName,
              description: tool.description ?? "",
              connection: id,
            });
          }
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ toolCount: tools.length, tools }, null, 2),
            },
          ],
        };
      }
    );
  }
}
