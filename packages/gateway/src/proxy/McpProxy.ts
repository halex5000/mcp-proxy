import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ConnectionId } from "@mcp-proxy/shared";
import type { ManagedProcess } from "../supervisor/ManagedProcess.js";
import { StreamMcpTransport } from "./StreamMcpTransport.js";
import { ToolFilter, type FilteredTool, type RawTool } from "./ToolFilter.js";
import type { ConnectionDefinition } from "@mcp-proxy/shared";

const MCP_CONNECT_TIMEOUT_MS = 5_000;
const MCP_TOOL_CALL_TIMEOUT_MS = 15_000;

/**
 * McpProxy connects to an already-running downstream MCP server process.
 *
 * It uses StreamMcpTransport to speak MCP over the process's existing
 * stdin/stdout streams — the streams that ManagedProcess opened when it
 * spawned the process. No second process is spawned here; one supervisor-owned
 * process is the canonical instance.
 *
 * On restart, the supervisor calls ManagedProcess.restart(), which replaces
 * the underlying process. McpProxy.reconnect() must then be called to attach
 * a fresh Client to the new process's streams.
 */
export class McpProxy {
  readonly connectionId: ConnectionId;
  private managedProcess: ManagedProcess;
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
    managedProcess: ManagedProcess,
    definition: ConnectionDefinition
  ) {
    this.connectionId = connectionId;
    this.managedProcess = managedProcess;
    this.definition = definition;
    this.filter = new ToolFilter(connectionId, definition);
  }

  async connect(): Promise<void> {
    const { stdin, stdout } = this.managedProcess;

    if (!stdin || !stdout) {
      throw new Error(
        `Process for ${this.connectionId} has no stdio streams — ` +
          `ensure ManagedProcess was started before calling connect()`
      );
    }

    // Connect to the already-running downstream server. StreamMcpTransport
    // reads from stdout (MCP responses) and writes to stdin (MCP requests).
    const transport = new StreamMcpTransport(stdout, stdin);

    this.client = new Client(
      { name: "mcp-gateway", version: "0.1.0" },
      { capabilities: {} }
    );

    try {
      await withTimeout(
        this.client.connect(transport),
        MCP_CONNECT_TIMEOUT_MS,
        `Timed out connecting to ${this.connectionId}`
      );
      await this.refreshTools();
    } catch (err) {
      this.client = null;
      await transport.close();
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    await this.client?.close();
    this.client = null;
    this._tools = [];
  }

  /** Reconnect after a process restart (new stdin/stdout streams). */
  async reconnect(): Promise<void> {
    await this.disconnect();
    await this.connect();
  }

  async refreshTools(): Promise<void> {
    if (!this.client) return;
    const result = await withTimeout(
      this.client.listTools(),
      MCP_CONNECT_TIMEOUT_MS,
      `Timed out listing tools for ${this.connectionId}`
    );
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

    return await withTimeout(
      this.client.callTool({
        name: tool.name,
        arguments: args,
      }),
      MCP_TOOL_CALL_TIMEOUT_MS,
      `Timed out calling ${publicName}`
    );
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
