import type { ConnectionDefinition } from "@mcp-proxy/shared";

export interface RawTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface FilteredTool extends RawTool {
  isVisible: boolean;
  isSafe: boolean;
  /** Namespaced name exposed to Copilot, e.g. "github__create_issue" */
  publicName: string;
}

/**
 * UNSAFE_TOOL_PATTERNS: Tools that can execute arbitrary code, spawn processes,
 * or write to the filesystem are hidden by default. Users must explicitly enable
 * the connection via Settings to unlock them.
 */
const UNSAFE_TOOL_PATTERNS = [
  /execute_code/i,
  /run_command/i,
  /run_script/i,
  /shell_exec/i,
  /eval_/i,
  /subprocess/i,
  /write_file/i,
  /delete_file/i,
  /browser_execute_script/i,
];

export class ToolFilter {
  private connectionId: string;
  private definition: ConnectionDefinition;

  constructor(connectionId: string, definition: ConnectionDefinition) {
    this.connectionId = connectionId;
    this.definition = definition;
  }

  filter(tools: RawTool[]): FilteredTool[] {
    return tools.map((tool) => {
      const isSafe = this.isSafe(tool.name);
      const isAllowed = this.isAllowed(tool.name);
      const isDenied = this.isDenied(tool.name);
      const isConnectionUnsafe = !this.definition.safeByDefault;

      // Connections marked unsafe require explicit enable at the connection level.
      // Even if the connection is enabled, unsafe individual tools stay hidden.
      const isVisible = isAllowed && !isDenied && (isSafe || !isConnectionUnsafe);

      return {
        ...tool,
        isVisible,
        isSafe,
        publicName: `${this.connectionId}__${tool.name}`,
      };
    });
  }

  private isSafe(toolName: string): boolean {
    return !UNSAFE_TOOL_PATTERNS.some((pattern) => pattern.test(toolName));
  }

  private isAllowed(toolName: string): boolean {
    if (!this.definition.allowlist || this.definition.allowlist.length === 0) {
      return true;
    }
    return this.definition.allowlist.some((pattern) =>
      this.matchGlob(pattern, toolName)
    );
  }

  private isDenied(toolName: string): boolean {
    if (!this.definition.denylist || this.definition.denylist.length === 0) {
      return false;
    }
    return this.definition.denylist.some((pattern) =>
      this.matchGlob(pattern, toolName)
    );
  }

  private matchGlob(pattern: string, name: string): boolean {
    // Simple glob: * matches anything within a segment, ** matches across segments
    const regex = new RegExp(
      "^" +
        pattern
          .replace(/\*\*/g, ".+")
          .replace(/\*/g, "[^_]+")
          .replace(/\?/g, ".") +
        "$"
    );
    return regex.test(name);
  }
}
