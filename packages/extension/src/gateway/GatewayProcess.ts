import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { AUTH_TOKEN_ENV, parseGatewayReady } from "@mcp-proxy/shared";

/**
 * GatewayProcess manages the lifecycle of the single gateway subprocess.
 *
 * The gateway is a Node.js script bundled with the extension. This class:
 *  - Generates a per-session bearer token
 *  - Spawns the gateway on activation, passing the token via env
 *  - Reads its stderr for the GATEWAY_READY port announcement
 *  - Kills it on extension deactivation
 *  - Surfaces stderr output to a VS Code output channel for diagnostics
 *
 * The gateway serves both the /mcp transport (which VS Code connects to via the
 * McpHttpServerDefinition we register) and the /control API (which the extension
 * drives) on the announced port. The port and token are read by the MCP provider
 * and the control client.
 */
export class GatewayProcess implements vscode.Disposable {
  private proc: cp.ChildProcess | null = null;
  private _port: number | null = null;
  private readonly _authToken: string;
  private outputChannel: vscode.OutputChannel;
  private extensionPath: string;

  private _onReady = new vscode.EventEmitter<number>();
  readonly onReady = this._onReady.event;

  private _onCrash = new vscode.EventEmitter<number | null>();
  readonly onCrash = this._onCrash.event;

  constructor(context: vscode.ExtensionContext) {
    this.extensionPath = context.extensionPath;
    this._authToken = crypto.randomBytes(32).toString("hex");
    this.outputChannel = vscode.window.createOutputChannel(
      "Managed Connections — Gateway"
    );
  }

  get port(): number | null {
    return this._port;
  }

  /** Shared bearer token guarding both /mcp and /control on the gateway. */
  get authToken(): string {
    return this._authToken;
  }

  /** The localhost URI VS Code's McpHttpServerDefinition should target. */
  get mcpUri(): string | null {
    return this._port ? `http://127.0.0.1:${this._port}/mcp` : null;
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
          [AUTH_TOKEN_ENV]: this._authToken,
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
        // MCP traffic now flows over HTTP (/mcp), not stdio, so stdout carries
        // only incidental logging. Surface it in the diagnostics channel.
        this.outputChannel.appendLine(`[gateway] ${chunk.toString().trim()}`);
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
    // The gateway entrypoint lives in a different place depending on how the
    // extension is running:
    //
    //   • Production (packaged .vsix): the gateway is bundled with the extension
    //     at dist/gateway-server/index.js.
    //   • Development (Extension Development Host in this monorepo): the gateway
    //     is a sibling workspace package at packages/gateway/dist/index.js.
    //
    // Note: dist/gateway/ is already used for the extension's OWN compiled
    // GatewayProcess/GatewayClient, so the bundled gateway server must NOT be
    // placed there — we use dist/gateway-server/ to avoid the collision.
    const candidates = [
      // Packaged / bundled gateway server
      path.join(this.extensionPath, "dist", "gateway-server", "index.js"),
      // Monorepo dev layout: packages/extension → packages/gateway
      path.join(this.extensionPath, "..", "gateway", "dist", "index.js"),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    throw new Error(
      "Could not locate the gateway entrypoint. Tried:\n" +
        candidates.map((c) => `  - ${c}`).join("\n") +
        "\n\nIf you are running from source, build the gateway first: " +
        "`npm run build` from the repo root (this produces packages/gateway/dist/index.js)."
    );
  }
}
