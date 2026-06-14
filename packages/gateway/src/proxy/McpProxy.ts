import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ConnectionId } from "@mcp-proxy/shared";
import type { ManagedProcess } from "../supervisor/ManagedProcess.js";
import { ToolFilter, type FilteredTool, type RawTool } from "./ToolFilter.js";
import type { ConnectionDefinition } from "@mcp-proxy/shared";

/**
 * McpProxy wraps a single downstream MCP server process with an MCP client,
 * discovers its tools, and proxies tool calls on behalf of the gateway server.
 *
 * The gateway's MCP server (exposed to VS Code) aggregates tools from all
 * active proxies, namespaced by connection ID to avoid collisions.
 */
export class McpProxy {
  readonly connectionId: ConnectionId;
  private process: ManagedProcess;
  private definition: ConnectionDefinition;
  private client: Client | null = null;
  private filter: ToolFilter;
  private _tools: FilteredTool[] = [];

  get tools(): FilteredTool[] {
    return this._tools;
  }

  get isConnected(): boolean {
    return this.client !== null;
  }

  constructor(
    connectionId: ConnectionId,
    process: ManagedProcess,
    definition: ConnectionDefinition
  ) {
    this.connectionId = connectionId;
    this.process = process;
    this.definition = definition;
    this.filter = new ToolFilter(connectionId, definition);
  }

  async connect(): Promise<void> {
    if (!this.process.stdin || !this.process.stdout) {
      throw new Error(`Process for ${this.connectionId} has no stdio streams`);
    }

    const transport = new StdioClientTransport({
      command: this.definition.command!,
      args: this.definition.args ?? [],
    });

    this.client = new Client(
      { name: "mcp-gateway", version: "0.1.0" },
      { capabilities: { tools: {} } }
    );

    await this.client.connect(transport);
    await this.refreshTools();
  }

  async disconnect(): Promise<void> {
    await this.client?.close();
    this.client = null;
    this._tools = [];
  }

  async refreshTools(): Promise<void> {
    if (!this.client) return;
    const result = await this.client.listTools();
    const raw: RawTool[] = result.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    this._tools = this.filter.filter(raw);
  }

  async callTool(
    publicName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    if (!this.client) {
      throw new Error(`Connection ${this.connectionId} is not connected`);
    }

    const tool = this._tools.find((t) => t.publicName === publicName);
    if (!tool) {
      throw new Error(`Tool ${publicName} not found in ${this.connectionId}`);
    }
    if (!tool.isVisible) {
      throw new Error(
        `Tool ${publicName} is not available (hidden by safety policy)`
      );
    }

    const result = await this.client.callTool({
      name: tool.name,  // original name, not namespaced
      arguments: args,
    });

    return result;
  }
}
