import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { SidecarError } from "../../errors/sidecar";
import { createLogger } from "../../logging/logger";
import type { RestartConfig, SidecarDefinition, SidecarStatus } from "./types";

const logger = createLogger("sidecar:process");

const DEFAULT_RESTART: Required<RestartConfig> = {
  enabled: true,
  maxRestarts: 5,
  restartWindow: 60_000,
  restartDelay: 1_000,
};

const DEFAULT_BUFFER_SIZE = 1_000;

export class ProcessManager {
  private childProcess: ChildProcess | null = null;
  private _status: SidecarStatus = "stopped";
  private _port = 0;
  private restartCount = 0;
  private restartWindowStart = 0;
  private outputBuffer: string[] = [];
  private statusListeners: Array<(status: SidecarStatus) => void> = [];
  private stopping = false;

  private readonly command: string;
  private readonly args: string[];
  private readonly cwd: string;
  private readonly env: Record<string, string>;
  private readonly configPort: number;
  private readonly restartConfig: Required<RestartConfig>;
  private readonly stdinEnabled: boolean;
  private readonly bufferSize: number;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  /** Shell metacharacters that must not appear in the command string. */
  private static readonly SHELL_META = /[;|&$`\n\r]/;

  constructor(config: SidecarDefinition) {
    this.command = ProcessManager.validateCommand(config.command);
    this.args = config.args ?? [];
    this.cwd = ProcessManager.validateCwd(config.cwd);
    this.env = config.env ?? {};
    this.configPort = config.port ?? 0;
    this.restartConfig = { ...DEFAULT_RESTART, ...config.restart };
    this.bufferSize = DEFAULT_BUFFER_SIZE;
    this.stdinEnabled = config.mode === "stdio";
  }

  private static validateCommand(command: string): string {
    if (!command || !command.trim()) {
      throw new SidecarError("Sidecar command must be a non-empty string", {
        isRetryable: false,
      });
    }
    if (ProcessManager.SHELL_META.test(command)) {
      throw new SidecarError(
        "Sidecar command must not contain shell metacharacters",
        { context: { command }, isRetryable: false },
      );
    }
    return command;
  }

  private static validateCwd(cwd?: string): string {
    if (!cwd) return process.cwd();
    if (cwd.includes("\0")) {
      throw new SidecarError("Sidecar cwd must not contain null bytes", {
        isRetryable: false,
      });
    }
    const resolved = path.resolve(cwd);
    if (!fs.existsSync(resolved)) {
      throw new SidecarError(`Sidecar cwd does not exist: ${resolved}`, {
        context: { cwd: resolved },
        isRetryable: false,
      });
    }
    return resolved;
  }

  get status(): SidecarStatus {
    return this._status;
  }

  get port(): number {
    return this._port;
  }

  async spawn(): Promise<void> {
    if (this.childProcess) {
      await this.stop();
    }

    // Skip port resolution for stdio mode
    if (!this.stdinEnabled) {
      this._port = this.configPort || (await this.resolvePort());
    }
    this.setStatus("starting");

    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      ...this.env,
    };

    // Only set PORT env vars in HTTP mode
    if (!this.stdinEnabled) {
      childEnv.PORT = String(this._port);
      childEnv.SIDECAR_PORT = String(this._port);
    }

    const stdioOpt: ["pipe", "pipe", "pipe"] | ["ignore", "pipe", "pipe"] = this
      .stdinEnabled
      ? ["pipe", "pipe", "pipe"]
      : ["ignore", "pipe", "pipe"];

    logger.info(
      "Spawning sidecar: %s %s (mode: %s, %scwd: %s)",
      this.command,
      this.args.join(" "),
      this.stdinEnabled ? "stdio" : "http",
      this.stdinEnabled ? "" : `port: ${this._port}, `,
      this.cwd,
    );

    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: childEnv,
      stdio: stdioOpt,
      shell: false,
    });
    this.childProcess = child;

    // In stdio mode, stdout is owned by the StdioBridge — do not buffer it here.
    if (!this.stdinEnabled) {
      child.stdout?.on("data", (chunk: Buffer) => {
        const lines = chunk.toString().split("\n").filter(Boolean);
        for (const line of lines) {
          this.appendOutput(`[stdout] ${line}`);
          logger.debug("sidecar stdout: %s", line);
        }
      });
    }

    child.stderr?.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        this.appendOutput(`[stderr] ${line}`);
        logger.debug("sidecar stderr: %s", line);
      }
    });

    child.on("exit", (code, signal) => {
      this.handleExit(code, signal);
    });

    child.on("error", (err) => {
      logger.error("Sidecar process error: %s", err.message);
      this.childProcess = null;
      this.setStatus("crashed");
    });
  }

  async stop(timeout = 10_000): Promise<void> {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (!this.childProcess) return;

    this.stopping = true;
    const child = this.childProcess;

    return new Promise<void>((resolve) => {
      const forceKillTimer = setTimeout(() => {
        logger.warn("Sidecar did not exit in time, sending SIGKILL");
        child.kill("SIGKILL");
      }, timeout);

      child.once("exit", () => {
        clearTimeout(forceKillTimer);
        this.childProcess = null;
        this.setStatus("stopped");
        this.stopping = false;
        resolve();
      });

      child.kill("SIGTERM");
    });
  }

  async restart(): Promise<void> {
    logger.info("Restarting sidecar process");
    await this.stop();
    await this.spawn();
  }

  setHealthy(): void {
    if (this._status === "starting" || this._status === "unhealthy") {
      this.setStatus("healthy");
    }
  }

  setUnhealthy(): void {
    if (this._status === "healthy" || this._status === "starting") {
      this.setStatus("unhealthy");
    }
  }

  onStatusChange(cb: (status: SidecarStatus) => void): void {
    this.statusListeners.push(cb);
  }

  getOutput(lines?: number): string[] {
    if (lines === undefined) return [...this.outputBuffer];
    return this.outputBuffer.slice(-lines);
  }

  getStdin(): Writable | null {
    return this.childProcess?.stdin ?? null;
  }

  getStdout(): Readable | null {
    return this.childProcess?.stdout ?? null;
  }

  private setStatus(status: SidecarStatus): void {
    this._status = status;
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }

  private appendOutput(line: string): void {
    this.outputBuffer.push(line);
    if (this.outputBuffer.length > this.bufferSize) {
      this.outputBuffer.shift();
    }
  }

  private handleExit(code: number | null, signal: string | null): void {
    logger.info("Sidecar process exited (code: %s, signal: %s)", code, signal);
    this.childProcess = null;

    if (this.stopping) return;

    if (!this.restartConfig.enabled) {
      this.setStatus("crashed");
      return;
    }

    this.resetRestartCountIfWindowExpired();
    this.restartCount++;

    if (this.restartCount > this.restartConfig.maxRestarts) {
      logger.error(
        "Sidecar exceeded max restarts (%d), giving up",
        this.restartConfig.maxRestarts,
      );
      this.setStatus("crashed");
      return;
    }

    logger.info(
      "Restarting sidecar in %dms (attempt %d/%d)",
      this.restartConfig.restartDelay,
      this.restartCount,
      this.restartConfig.maxRestarts,
    );

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping) {
        this.spawn().catch((err) => {
          logger.error("Failed to restart sidecar: %s", err.message);
          this.setStatus("crashed");
        });
      }
    }, this.restartConfig.restartDelay);
  }

  private resetRestartCountIfWindowExpired(): void {
    const now = Date.now();
    if (now - this.restartWindowStart > this.restartConfig.restartWindow) {
      this.restartCount = 0;
      this.restartWindowStart = now;
    }
  }

  private resolvePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.listen(0, () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close();
          reject(new Error("Failed to resolve port"));
          return;
        }
        const port = address.port;
        server.close(() => resolve(port));
      });
      server.on("error", reject);
    });
  }
}
