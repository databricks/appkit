import { createLogger } from "@/logging";

const logger = createLogger("service-registry");

/** A booted core service. Resolved via the typed `get<T>` helper. */
interface BootedService {
  readonly name: string;
  readonly instance: unknown;
  shutdown(): Promise<void>;
}

/**
 * Factory that boots a core service. `boot()` returns `null` for
 * intentionally-absent services (e.g. telemetry without an OTLP endpoint).
 */
export interface CoreServiceFactory<T = unknown> {
  readonly name: string;
  boot(): Promise<{ instance: T; shutdown(): Promise<void> } | null>;
}

/**
 * Manages the lifecycle of core services and acts as a typed locator.
 * Services boot in provided order and shut down in reverse.
 */
export class CoreServiceRegistry {
  private constructor(private readonly booted: BootedService[]) {}

  /** Boots services in order; unwinds already-booted services on failure. */
  static async boot(
    factories: readonly CoreServiceFactory[],
  ): Promise<CoreServiceRegistry> {
    const booted: BootedService[] = [];
    try {
      for (const factory of factories) {
        const result = await factory.boot();
        if (!result) continue;
        booted.push({
          name: factory.name,
          instance: result.instance,
          shutdown: result.shutdown,
        });
        logger.debug("Booted core service: %s", factory.name);
      }
      return new CoreServiceRegistry(booted);
    } catch (error) {
      await CoreServiceRegistry.unwind(booted);
      throw error;
    }
  }

  /** Returns the booted instance for `name`, or `null` if not booted. */
  get<T>(name: string): T | null {
    for (const service of this.booted) {
      if (service.name === name) {
        return service.instance as T;
      }
    }
    return null;
  }

  /** Shuts down services in the reverse order they were booted. */
  async shutdown(): Promise<void> {
    await CoreServiceRegistry.unwind(this.booted);
  }

  private static async unwind(booted: BootedService[]): Promise<void> {
    while (booted.length > 0) {
      const service = booted.pop();
      if (!service) continue;

      try {
        await service.shutdown();
        logger.debug("Shutdown core service: %s", service.name);
      } catch (error) {
        logger.error("Service %s shutdown failed: %O", service.name, error);
      }
    }
  }
}
