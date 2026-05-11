/**
 * Composes the {@link CoreServiceFactory}s that AppKit boots.
 * Keeps `core/appkit.ts` free of concrete service imports.
 *
 * @internal
 */
import type { CacheConfig } from "shared";
import { CacheManager } from "../cache";
import { type TelemetryConfig, TelemetryManager } from "../telemetry";
import type { CoreServiceFactory } from "./service-registry";

interface BootstrapConfig {
  telemetry?: TelemetryConfig;
  cache?: CacheConfig;
}

/**
 * Returns factories in boot order: telemetry first so other services can
 * record traces during their own boot.
 *
 * @internal
 */
export function composeCoreFactories(
  config: BootstrapConfig,
): readonly CoreServiceFactory[] {
  return [
    TelemetryManager.factory(config.telemetry),
    CacheManager.factory(config.cache),
  ];
}
