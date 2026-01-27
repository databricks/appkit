import type { ChildProcess } from "node:child_process";
import { fork } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { noopHooks, type TaskSystemHooks } from "@/observability";
import type { RepositoryConfig } from "@/persistence";
import {
  DEFAULT_FLUSH_CONFIG,
  type FlushConfig,
  type FlushStats,
  type FlushStatus,
  type FlushWorkerStats,
  type IPCCommand,
  type IPCMessage,
} from "./types";

/**
 * Full configuration for the Flush manager
 */
export interface FlushManagerConfig extends FlushConfig {
  repository: RepositoryConfig;
}

/**
 * Flush manager spawns and monitors a worker process for flushing
 * events from the EventLog to the repository.
 */
export class Flush {
  private readonly config: Required<Omit<FlushConfig, "repository">> & {
    repository: RepositoryConfig;
  };
  private readonly hooks: TaskSystemHooks;

  private worker: ChildProcess | null = null;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private restartCount: number = 0;
  private isShuttingDown: boolean = false;
  private lastStats: FlushWorkerStats | null = null;

  constructor(
    config: Partial<FlushManagerConfig> & { repository: RepositoryConfig },
    hooks: TaskSystemHooks = noopHooks,
  ) {
    this.config = {
      ...DEFAULT_FLUSH_CONFIG,
      ...config,
      repository: config.repository,
    };
    this.hooks = hooks;
  }

  /**
   * Initialize the flush manager
   * Spawns the worker process and starts health checks
   */
  async initialize(): Promise<void> {
    await this.spawnWorker();
    this.startHealthCheck();

    this.hooks.log({
      severity: "info",
      message: "Flush manager initialized",
      attributes: {
        pid: this.worker?.pid,
      },
    });
  }

  /**
   * Shutdown the flush manager and worker
   * @param timeoutMs - Maximum time to wait for graceful shutdown
   */
  async shutdown(timeoutMs: number = 30_000): Promise<void> {
    this.isShuttingDown = true;
    this.stopHealthCheck();

    if (!this.worker || !this.isAlive()) {
      return;
    }

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.hooks.log({
          severity: "warn",
          message: "Worker did not exit in time, sending SIGKILL",
        });
        this.worker?.kill("SIGKILL");
        resolve();
      }, timeoutMs);

      this.worker?.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });

      this.sendCommand({ type: "shutdown", payload: { timeoutMs } });
    });
  }

  /**
   * Check if the worker process is alive
   */
  isAlive(): boolean {
    if (!this.worker) return false;

    try {
      if (!this.worker.pid) return false;

      // sending signal 0 tests if process exists without killing it
      process.kill(this.worker.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get worker stats via IPC (async, fetches fresh stats)
   * Returns cached stats if worker doesn't respond in time
   */
  async getWorkerStats(): Promise<FlushWorkerStats | null> {
    if (!this.isAlive()) return null;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve(this.lastStats);
      }, 1000);

      const handler = (message: IPCMessage) => {
        if (message.type === "stats") {
          clearTimeout(timeout);
          this.worker?.off("message", handler);
          this.lastStats = message.payload;
          resolve(message.payload);
        }
      };

      this.worker?.on("message", handler);
      this.sendCommand({ type: "get-stats" });
    });
  }

  /**
   * Get combined process and worker stats (sync, uses cached stats)
   */
  getStats(): FlushStats {
    const workerStats = this.lastStats;

    return {
      process: {
        isAlive: this.isAlive(),
        pid: this.worker?.pid ?? null,
        restartCount: this.restartCount,
        isShuttingDown: this.isShuttingDown,
      },
      worker: workerStats
        ? {
            isRunning: true,
            flushCount: workerStats.flushCount,
            errorCount: workerStats.errorCount,
            consecutiveErrors: workerStats.consecutiveErrors,
            totalEntriesFlushed: workerStats.totalEntriesFlushed,
            lastFlushAt: workerStats.lastFlushAt,
            lastErrorAt: workerStats.lastErrorAt,
          }
        : null,
    };
  }

  /**
   * Get current status (legacy method, use getStats instead)
   */
  getStatus(): FlushStatus {
    return {
      isAlive: this.isAlive(),
      isShuttingDown: this.isShuttingDown,
      restartCount: this.restartCount,
      pid: this.worker?.pid ?? null,
      lastStats: this.lastStats,
    };
  }

  /**
   * Spawn the worker process
   */
  private async spawnWorker(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // get the path to the worker entry file
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const workerPath = path.join(__dirname, "flush-worker-entry.js");

      this.worker = fork(workerPath, [], {
        env: {
          ...process.env,
          FLUSH_CONFIG: JSON.stringify(this.config),
        },
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      });

      // forward worker output for debugging
      this.worker.stdout?.on("data", (data: Buffer) => {
        process.stdout.write(`[FlushWorker] ${data.toString()}`);
      });

      this.worker.stderr?.on("data", (data: Buffer) => {
        process.stderr.write(`[FlushWorker] ${data.toString()}`);
      });

      // wait for ready message
      const onReady = (message: IPCMessage) => {
        if (message.type === "ready") {
          this.worker?.off("message", onReady);
          resolve();
        } else if (message.type === "error") {
          this.worker?.off("message", onReady);
          reject(new Error(message.payload));
        }
      };
      this.worker?.on("message", onReady);

      // handle worker errors
      this.worker?.on("error", (error) => {
        this.hooks.log({
          severity: "error",
          message: "Worker process error",
          error,
        });
        if (!this.isShuttingDown) {
          this.handleWorkerExit();
        }
      });

      // handle worker exit
      this.worker?.on("exit", (code, signal) => {
        this.hooks.log({
          severity: "warn",
          message: `Worker exited with code ${code} and signal ${signal}`,
        });
        if (!this.isShuttingDown) {
          this.handleWorkerExit();
        }
      });

      // timeout for worker startup
      setTimeout(() => {
        if (!this.isAlive()) {
          reject(new Error("Worker failed to start"));
        }
      }, 5000);
    });
  }

  /**
   * Handle unexpected worker exit - attempt restart
   */
  private async handleWorkerExit(): Promise<void> {
    if (this.isShuttingDown) return;

    if (this.restartCount >= this.config.maxRestarts) {
      this.hooks.log({
        severity: "error",
        message: "Max worker restarts reached, giving up",
        attributes: {
          restartCount: this.restartCount,
          maxRestarts: this.config.maxRestarts,
        },
      });
      return;
    }

    this.restartCount++;

    this.hooks.log({
      severity: "info",
      message: `Restarting worker (${this.restartCount}/${this.config.maxRestarts})`,
    });

    await new Promise((resolve) =>
      setTimeout(resolve, this.config.restartDelayMs),
    );

    try {
      await this.spawnWorker();
      this.hooks.log({
        severity: "info",
        message: "Worker restarted successfully",
      });
    } catch (error) {
      this.hooks.log({
        severity: "error",
        message: "Failed to restart worker",
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  /**
   * Start periodic health checks
   */
  private startHealthCheck(): void {
    this.healthCheckTimer = setInterval(() => {
      if (!this.isAlive() && !this.isShuttingDown) {
        this.hooks.log({
          severity: "warn",
          message: "Health check detected dead worker, restarting",
        });
        this.handleWorkerExit();
      }
    }, this.config.healthCheckIntervalMs);

    // don't keep process alive just for health checks
    this.healthCheckTimer.unref();
  }

  /**
   * Stop health checks
   */
  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * Send an IPC command to the worker
   */
  private sendCommand(command: IPCCommand): void {
    if (this.worker?.connected) {
      this.worker.send(command);
    }
  }
}
