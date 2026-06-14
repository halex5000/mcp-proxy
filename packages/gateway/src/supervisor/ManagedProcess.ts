import { spawn, type ChildProcess } from "child_process";
import type { ConnectionId } from "@mcp-proxy/shared";
import type { LogLine } from "@mcp-proxy/shared";

const MAX_LOG_LINES = 200;
const RESTART_BACKOFF_MS = [1000, 2000, 5000, 15000, 30000];

export type ProcessState =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "crashed";

export type ProcessEventKind = "started" | "stopped" | "crashed" | "log";

export interface ProcessEvent {
  kind: ProcessEventKind;
  connectionId: ConnectionId;
  exitCode?: number | null;
  log?: LogLine;
  error?: string;
}

export type ProcessEventListener = (event: ProcessEvent) => void;

export interface ProcessOptions {
  id: ConnectionId;
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  autoRestart: boolean;
}

export class ManagedProcess {
  readonly id: ConnectionId;
  private opts: ProcessOptions;
  private proc: ChildProcess | null = null;
  private _state: ProcessState = "idle";
  private logs: LogLine[] = [];
  private crashCount = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<ProcessEventListener>();
  private startedAt?: number;

  get state(): ProcessState {
    return this._state;
  }

  get uptime(): number | undefined {
    return this.startedAt ? Date.now() - this.startedAt : undefined;
  }

  get recentLogs(): LogLine[] {
    return [...this.logs];
  }

  get crashes(): number {
    return this.crashCount;
  }

  constructor(opts: ProcessOptions) {
    this.id = opts.id;
    this.opts = opts;
  }

  onEvent(listener: ProcessEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: ProcessEvent): void {
    for (const l of this.listeners) l(event);
  }

  async start(): Promise<void> {
    if (this._state === "running" || this._state === "starting") return;
    this.clearRestartTimer();
    this._state = "starting";

    const proc = spawn(this.opts.command, this.opts.args, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...this.opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc = proc;

    proc.stdout?.on("data", (_chunk: Buffer) => {
      // stdout carries MCP protocol messages (newline-delimited JSON).
      // McpProxy reads these directly via StreamMcpTransport. We do NOT
      // consume or log them here — doing so would corrupt the protocol stream.
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      this.appendLog("stderr", chunk.toString());
    });

    proc.on("spawn", () => {
      this._state = "running";
      this.startedAt = Date.now();
      this.emit({ kind: "started", connectionId: this.id });
    });

    proc.on("error", (err) => {
      this.appendLog("stderr", `spawn error: ${err.message}`);
    });

    proc.on("close", (code) => {
      const wasCrash = this._state !== "stopping";
      this._state = wasCrash ? "crashed" : "stopped";
      this.proc = null;

      if (wasCrash) {
        this.crashCount++;
        this.emit({ kind: "crashed", connectionId: this.id, exitCode: code });
        if (this.opts.autoRestart) {
          this.scheduleRestart();
        }
      } else {
        this.emit({ kind: "stopped", connectionId: this.id, exitCode: code });
      }
    });
  }

  async stop(): Promise<void> {
    this.clearRestartTimer();
    if (!this.proc || this._state === "stopped" || this._state === "idle") return;

    this._state = "stopping";
    this.proc.kill("SIGTERM");

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.proc?.kill("SIGKILL");
        resolve();
      }, 5000);

      this.proc!.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  async restart(): Promise<void> {
    await this.stop();
    this.crashCount = 0;
    await this.start();
  }

  /** The stdin stream for MCP protocol communication with VS Code. */
  get stdin() {
    return this.proc?.stdin ?? null;
  }

  /** The stdout stream for MCP protocol communication with VS Code. */
  get stdout() {
    return this.proc?.stdout ?? null;
  }

  private appendLog(level: "stdout" | "stderr", text: string): void {
    const line: LogLine = { ts: Date.now(), level, text: text.trimEnd() };
    this.logs.push(line);
    if (this.logs.length > MAX_LOG_LINES) {
      this.logs.shift();
    }
    this.emit({ kind: "log", connectionId: this.id, log: line });
  }

  private scheduleRestart(): void {
    const backoffMs =
      RESTART_BACKOFF_MS[Math.min(this.crashCount - 1, RESTART_BACKOFF_MS.length - 1)];
    this.restartTimer = setTimeout(() => {
      this.start().catch((err) => {
        this.appendLog("stderr", `auto-restart failed: ${err}`);
      });
    }, backoffMs);
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }
}
