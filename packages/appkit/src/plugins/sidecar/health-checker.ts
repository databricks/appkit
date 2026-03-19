import { createLogger } from "../../logging/logger";
import type { HealthCheckConfig } from "./types";

const logger = createLogger("sidecar:health");

const DEFAULTS: Required<HealthCheckConfig> = {
  path: "/health",
  interval: 5_000,
  timeout: 3_000,
  unhealthyThreshold: 3,
};

export class HealthChecker {
  private interval: ReturnType<typeof setInterval> | null = null;
  private consecutiveFailures = 0;
  private readonly config: Required<HealthCheckConfig>;
  private readonly port: number;

  constructor(port: number, config?: HealthCheckConfig) {
    this.port = port;
    this.config = { ...DEFAULTS, ...config };
  }

  async waitForReady(timeout: number, signal?: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + timeout;
    const pollInterval = Math.min(1_000, this.config.timeout);

    while (Date.now() < deadline) {
      if (signal?.aborted) return false;

      if (await this.check()) {
        logger.info("Sidecar health check passed on port %d", this.port);
        return true;
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    return false;
  }

  start(callbacks: { onHealthy: () => void; onUnhealthy: () => void }): void {
    this.stop();

    this.interval = setInterval(async () => {
      const healthy = await this.check();

      if (healthy) {
        this.consecutiveFailures = 0;
        callbacks.onHealthy();
      } else {
        this.consecutiveFailures++;
        logger.warn(
          "Sidecar health check failed (%d/%d)",
          this.consecutiveFailures,
          this.config.unhealthyThreshold,
        );

        if (this.consecutiveFailures >= this.config.unhealthyThreshold) {
          callbacks.onUnhealthy();
          this.consecutiveFailures = 0;
        }
      }
    }, this.config.interval);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async check(): Promise<boolean> {
    const url = `http://localhost:${this.port}${this.config.path}`;
    try {
      const response = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(this.config.timeout),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
