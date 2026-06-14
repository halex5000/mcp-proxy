import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { McpProxy } from "./proxy/McpProxy.js";
import type { ConnectionId, ConnectionStatusEntry } from "@mcp-proxy/shared";
import type { HealthAggregator } from "./health/HealthAggregator.js";
import type { Supervisor } from "./supervisor/Supervisor.js";

type StatusProvider = () => ConnectionStatusEntry[];
type RestartHandler = (id: ConnectionId) => Promise<unknown>;

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
  private statusProvider: StatusProvider | undefined;
  private restartHandler: RestartHandler | undefined;

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

  setStatusProvider(provider: StatusProvider): void {
    this.statusProvider = provider;
  }

  setRestartHandler(handler: RestartHandler): void {
    this.restartHandler = handler;
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
      "connections_status",
      [
        "Returns all connection statuses as structured JSON for assistant diagnostics.",
        "Use this before explaining what capabilities are available or broken.",
      ].join(" "),
      {},
      async () => this.jsonToolResult({ connections: this.currentStatuses() })
    );

    server.tool(
      "connection_health",
      [
        "Returns health for one connection or all connections.",
        "Use this when the user asks why a connection or tool is not working.",
      ].join(" "),
      {
        connectionId: z.string().optional(),
      },
      async ({ connectionId }) => {
        const statuses = this.currentStatuses();
        const results = connectionId
          ? statuses.filter((entry) => entry.id === connectionId)
          : statuses;
        return this.jsonToolResult({ connections: results });
      }
    );

    server.tool(
      "connection_diagnostics",
      [
        "Returns assistant-readable diagnostics for one connection or all connections.",
        "Prefer assistantSummary and userMessage when explaining failures to users.",
      ].join(" "),
      {
        connectionId: z.string().optional(),
      },
      async ({ connectionId }) => {
        const statuses = this.currentStatuses();
        const results = (connectionId
          ? statuses.filter((entry) => entry.id === connectionId)
          : statuses
        ).map((entry) => ({
          id: entry.id,
          name: entry.name,
          health: entry.health,
          diagnostics: entry.health.diagnostics,
        }));
        return this.jsonToolResult({ connections: results });
      }
    );

    server.tool(
      "restart_connection",
      [
        "Restarts a managed connection when the health action includes restart.",
        "Use this only when the user asks you to fix a restartable connection.",
      ].join(" "),
      {
        connectionId: z.string(),
      },
      async ({ connectionId }) => {
        if (!this.restartHandler) {
          return this.jsonToolResult(
            { ok: false, message: "Restart is not available." },
            true
          );
        }

        try {
          const result = await this.restartHandler(connectionId);
          return this.jsonToolResult({ ok: true, result });
        } catch (err) {
          return this.jsonToolResult({ ok: false, message: String(err) }, true);
        }
      }
    );

    server.tool(
      "explain_connection_problem",
      [
        "Returns plain-language summaries of current connection problems.",
        "Use this when the user asks what is wrong or what action they need to take.",
      ].join(" "),
      {
        connectionId: z.string().optional(),
      },
      async ({ connectionId }) => {
        const statuses = this.currentStatuses();
        const entries = connectionId
          ? statuses.filter((entry) => entry.id === connectionId)
          : statuses;
        return this.jsonToolResult({
          explanations: entries.map((entry) => ({
            id: entry.id,
            name: entry.name,
            state: entry.health.state,
            userMessage: entry.health.userMessage,
            assistantSummary: entry.health.assistantSummary,
            availableActions: entry.health.availableActions,
          })),
        });
      }
    );

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
        for (const entry of this.currentStatuses()) {
          if (connectionId && entry.id !== connectionId) continue;
          results[entry.id] = {
            status: entry.health.status,
            state: entry.health.state,
            label: entry.health.label,
            message: entry.health.message,
            toolCount: entry.health.toolCount,
            hiddenToolCount: entry.health.hiddenToolCount,
            actions: entry.health.actions,
            assistantSummary: entry.health.assistantSummary,
          };
        }

        return this.jsonToolResult(results);
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

        return this.jsonToolResult({ toolCount: tools.length, tools });
      }
    );
  }

  private currentStatuses(): ConnectionStatusEntry[] {
    if (this.statusProvider) return this.statusProvider();

    return [...this.supervisor.getAllProcesses()].map(([id, proc]) => {
      const proxy = this.proxies.get(id);
      return {
        id,
        name: id,
        health: this.healthAggregator.compute(id, id, proc, proxy),
        tools:
          proxy?.tools.map((tool) => ({
            name: tool.name,
            publicName: tool.publicName,
            description: tool.description ?? "",
            isVisible: tool.isVisible,
            isSafe: tool.isSafe,
            hiddenReason: tool.hiddenReason,
          })) ?? [],
      };
    });
  }

  private jsonToolResult(value: unknown, isError = false) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(value, null, 2),
        },
      ],
      isError,
    };
  }
}
