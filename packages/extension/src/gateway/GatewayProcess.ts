import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";
import { parseGatewayReady } from "@mcp-proxy/shared";

/**
 * GatewayProcess manages the lifecycle of the gateway subprocess.
 *
 * The gateway is a Node.js binary bundled with the extension. This class:
 *  - Spawns it on extension activation
 *  - Reads its stderr for the GATEWAY_READY port announcement
 *  - Kills it on extension deactivation
 *  - Surfaces stderr output to a VS Code output channel for diagnostics
 */
export class GatewayProcess implements vscode.Disposable {
  private proc: cp.ChildProcess | null = null;
  private _port: number | null = null;
  private outputChannel: vscode.OutputChannel;
  private extensionPath: string;

  private _onReady = new vscode.EventEmitter<number>();
  readonly onReady = this._onReady.event;

  private _onCrash = new vscode.EventEmitter<number | null>();
  readonly onCrash = this._onCrash.event;

  constructor(context: vscode.ExtensionContext) {
    this.extensionPath = context.extensionPath;
    this.outputChannel = vscode.window.createOutputChannel(
      "Managed Connections — Gateway",
      { log: false }
    );
  }

  get port(): number | null {
    return this._port;
  }

  get isRunning(): boolean {
    return this.proc !== null && !this.proc.killed;
  }

  async start(): Promise<number> {
    if (this.proc) {
      throw new Error("Gateway is already running");
    }

    const gatewayPath = this.resolveGatewayPath();

    return new Promise<number>((resolve, reject) => {
      const proc = cp.spawn(process.execPath, [gatewayPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          NODE_ENV: "production",
        },
      });

      this.proc = proc;

      let resolved = false;

      // Gateway announces its control port on stderr
      proc.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        for (const line of text.split("\n")) {
          this.outputChannel.appendLine(`[gateway] ${line}`);

          if (!resolved) {
            const port = parseGatewayReady(line.trim());
            if (port !== null) {
              this._port = port;
              resolved = true;
              resolve(port);
              this._onReady.fire(port);
            }
          }
        }
      });

      proc.stdout?.on("data", (chunk: Buffer) => {
        // stdout is the MCP stdio channel — VS Code reads this directly.
        // We don't intercept it here; the McpServerDefinitionProvider points
        // VS Code at the gateway process, not this shim.
        this.outputChannel.appendLine(`[gateway/mcp] ${chunk.toString().trim()}`);
      });

      proc.on("error", (err) => {
        this.outputChannel.appendLine(`[gateway] process error: ${err.message}`);
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });

      proc.on("close", (code) => {
        this.outputChannel.appendLine(`[gateway] process exited with code ${code}`);
        this.proc = null;
        this._port = null;
        this._onCrash.fire(code);
      });

      const startTimeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          proc.kill();
          reject(new Error("Gateway did not announce its port within 15 seconds"));
        }
      }, 15_000);

      this._onReady.event(() => clearTimeout(startTimeout));
    });
  }

  stop(): void {
    if (this.proc && !this.proc.killed) {
      this.proc.kill("SIGTERM");
      this.proc = null;
      this._port = null;
    }
  }

  showOutput(): void {
    this.outputChannel.show();
  }

  dispose(): void {
    this.stop();
    this._onReady.dispose();
    this._onCrash.dispose();
    this.outputChannel.dispose();
  }

  private resolveGatewayPath(): string {
    // In production, the gateway binary is bundled at dist/gateway/index.js
    // alongside the extension's dist/extension.js.
    return path.join(this.extensionPath, "dist", "gateway", "index.js");
  }
}
