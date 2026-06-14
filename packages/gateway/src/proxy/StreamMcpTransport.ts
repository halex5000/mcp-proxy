import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Readable, Writable } from "node:stream";

/**
 * StreamMcpTransport implements the MCP stdio protocol (newline-delimited JSON)
 * over existing Readable/Writable streams — specifically the stdin/stdout of a
 * ManagedProcess that was already spawned by the supervisor.
 *
 * Why this exists:
 *   StdioClientTransport always spawns its own child process. Since the
 *   supervisor already owns the process lifecycle (crash detection, auto-restart,
 *   log capture from stderr), having McpProxy spawn a second process via
 *   StdioClientTransport would create two competing instances of the same server.
 *   This transport lets the MCP Client connect to the already-running process.
 *
 * Framing:
 *   Uses the same ReadBuffer and serializeMessage as the SDK's StdioClientTransport
 *   and StdioServerTransport: messages are newline-delimited JSON (not
 *   Content-Length framed — that is an LSP convention, not MCP's).
 */
export class StreamMcpTransport {
  private readable: Readable;
  private writable: Writable;
  private readBuffer = new ReadBuffer();

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(readable: Readable, writable: Writable) {
    this.readable = readable;
    this.writable = writable;
  }

  async start(): Promise<void> {
    this.readable.on("data", (chunk: Buffer) => {
      this.readBuffer.append(chunk);
      let msg: JSONRPCMessage | null;
      while ((msg = this.readBuffer.readMessage()) !== null) {
        this.onmessage?.(msg);
      }
    });

    this.readable.on("error", (err) => {
      this.onerror?.(err);
    });

    this.readable.on("close", () => {
      this.readBuffer.clear();
      this.onclose?.();
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      this.writable.write(serializeMessage(message), "utf8", (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    this.readBuffer.clear();
    // Do NOT close the underlying streams — ManagedProcess owns them.
    // Removing listeners prevents memory leaks if the transport is replaced
    // (e.g. after a restart) while the process is still running.
    this.readable.removeAllListeners("data");
    this.readable.removeAllListeners("error");
    this.readable.removeAllListeners("close");
  }
}
