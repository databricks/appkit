import type { CacheConfig } from "shared";
import { CacheManager } from "../cache";
import { createLogger } from "../logging";
import { TaskManager, type TaskOption } from "../tasks";
import { type TelemetryConfig, TelemetryManager } from "../telemetry";

const logger = createLogger("services");

interface ServiceEntry {
  readonly name: string;
  readonly instance: unknown;
  stop(): Promise<void>;
}

/** Holds booted core services and resolves them by name. */
export class ServiceManager {
  #services: ServiceEntry[] = [];

  /** Adds a service. `null` is ignored so callers can pass an opt-out result. */
  add(
    name: string,
    service: { instance: unknown; stop(): Promise<void> } | null,
  ): void {
    if (!service) return;
    this.#services.push({ name, ...service });
    logger.debug("Started: %s", name);
  }

  get<T>(name: string): T | null {
    for (const s of this.#services) {
      if (s.name === name) return s.instance as T;
    }
    return null;
  }

  /** Stops services in reverse start order. Per-service failures are logged. */
  async stop(): Promise<void> {
    while (this.#services.length > 0) {
      const s = this.#services.pop();
      if (!s) continue;
      try {
        await s.stop();
        logger.debug("Stopped: %s", s.name);
      } catch (error) {
        logger.error("Stop failed for %s: %O", s.name, error);
      }
    }
  }
}

/**
 * Boots the core services AppKit ships with. Adding a new service touches
 * only this function and the service module itself — the rest of the core
 * stays free of concrete service imports.
 */
export async function startCoreServices(config: {
  telemetry?: TelemetryConfig;
  cache?: CacheConfig;
  task?: TaskOption;
}): Promise<ServiceManager> {
  const services = new ServiceManager();
  try {
    services.add("telemetry", await TelemetryManager.boot(config.telemetry));
    services.add("cache", await CacheManager.boot(config.cache));
    if (config.task !== undefined && config.task !== false) {
      services.add("task", await TaskManager.boot(config.task));
    }
    return services;
  } catch (error) {
    await services.stop();
    throw error;
  }
}
