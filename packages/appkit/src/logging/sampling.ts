import { shouldExcludePath } from "../utils/path-exclusions";
import type { WideEventData } from "./wide-event";

/**
 * Sampling configuration for WideEvents
 */
export interface SamplingConfig {
  /** Always sample if any of these conditions are true */
  alwaysSampleIf: {
    /** Sample if event has errors */
    hasErrors: boolean;
    /** Sample if status code >= this value (e.g., 400) */
    statusCodeGte: number;
    /** Sample if duration >= this value in ms (e.g., 5000) */
    durationGte: number;
    /** Sample if cache was used (hit or miss tracked) */
    hasCacheInfo: boolean;
  };

  /** Sample rate for normal requests (0-1, e.g., 0.1 = 10%) */
  sampleRate: number;
}

/**
 * Get sample rate from environment variable or default to 1.0 (100%)
 */
function getSampleRate(): number {
  const envRate = process.env.APPKIT_SAMPLE_RATE;
  if (envRate) {
    const parsed = parseFloat(envRate);
    if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 1) {
      return parsed;
    }
  }
  return 1;
}

/**
 * Default sampling configuration
 */
export const DEFAULT_SAMPLING_CONFIG: SamplingConfig = {
  alwaysSampleIf: {
    hasErrors: true,
    statusCodeGte: 400,
    durationGte: 5000, // 5 seconds
    hasCacheInfo: true, // Always sample requests with cache info (hit or miss)
  },
  sampleRate: getSampleRate(),
};

/**
 * Simple hash function for deterministic sampling
 */
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

/**
 * Determine if a WideEvent should be sampled based on configuration.
 * Uses shared path exclusions from utils/path-exclusions.ts.
 */
export function shouldSample(
  event: WideEventData,
  config: SamplingConfig = DEFAULT_SAMPLING_CONFIG,
): boolean {
  // Check exclusions first using shared path exclusions
  if (shouldExcludePath(event.path)) {
    return false;
  }

  // Always sample if has errors
  if (config.alwaysSampleIf.hasErrors && event.error) {
    return true;
  }

  // Always sample if status code >= threshold
  if (
    config.alwaysSampleIf.statusCodeGte &&
    event.status_code &&
    event.status_code >= config.alwaysSampleIf.statusCodeGte
  ) {
    return true;
  }

  // Always sample if duration >= threshold
  if (
    config.alwaysSampleIf.durationGte &&
    event.duration_ms &&
    event.duration_ms >= config.alwaysSampleIf.durationGte
  ) {
    return true;
  }

  // Always sample if cache info is present (cache hit or miss)
  if (
    config.alwaysSampleIf.hasCacheInfo &&
    event.execution?.cache_hit !== undefined
  ) {
    return true;
  }

  // Sample based on sample rate
  if (config.sampleRate >= 1) {
    return true;
  }

  if (config.sampleRate <= 0) {
    return false;
  }

  // Deterministic sampling based on request ID
  const hash = hashString(event.request_id);
  return hash % 100 < config.sampleRate * 100;
}
