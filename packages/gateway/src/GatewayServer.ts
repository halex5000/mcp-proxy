import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { McpProxy } from "./proxy/McpProxy.js";
import type { ConnectionId } from "@mcp-proxy/shared";
import type { HealthAggregator } from "./health/HealthAggregator.js";
import type { Supervisor } from "./supervisor/Supervisor.js";

/**
 * GatewayServer is the MCP server VS Code connects to via stdio.
 *
 * It presents a unified tool namespace by aggregating tools from all active
 * downstream proxies. Tool names are namespaced by connection ID to prevent
 * collisions (e.g., github__create_issue, jira__create_issue).
 *
 * It also exposes meta-tools that Copilot can call to understand connection
 * health, enabling the assistant to explain problems to users autonomously.
 */
export class GatewayServer {
  private server: McpServer;
  private proxies = new Map<ConnectionId, McpProxy>();
  private healthAggregator: HealthAggregator;
  private supervisor: Supervisor;

  constructor(healthAggregator: HealthAggregator, supervisor: Supervisor) {
    this.healthAggregator = healthAggregator;
    this.supervisor = supervisor;

    this.server = new McpServer({
      name: "mcp-gateway",
      version: "0.1.0",
    });

    this.registerMetaTools();
  }

  registerProxy(id: ConnectionId, proxy: McpProxy): void {
    this.proxies.set(id, proxy);
    this.refreshTools();
  }

  removeProxy(id: ConnectionId): void {
    this.proxies.delete(id);
    this.refreshTools();
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }

  private refreshTools(): void {
    // Re-register all tools from active proxies.
    // In practice, we'd use server.setRequestHandler with a dynamic list;
    // here we register each tool directly as a typed handler.
    for (const [id, proxy] of this.proxies) {
      for (const tool of proxy.tools) {
        if (!tool.isVisible) continue;

        this.server.tool(
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
  private registerMetaTools(): void {
    this.server.tool(
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

    this.server.tool(
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
