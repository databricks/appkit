import { AsyncLocalStorage } from "node:async_hooks";
import { createDebug } from "./debug";
import { formatJson, formatPretty } from "./formatter";
import type { WideEvent, WideEventData } from "./wide-event";

/**
 * AsyncLocalStorage for WideEvent (used by middleware and logger)
 * @internal
 */
export const eventStorage = new AsyncLocalStorage<WideEvent>();

const debug = createDebug("context");

const IS_PRODUCTION = process.env.NODE_ENV === "production";
const SAMPLING_RATE = parseFloat(process.env.APPKIT_LOG_SAMPLING || "1.0");

/**
 * Get the current wide event if in request context.
 * @returns WideEvent if in request context, undefined otherwise
 */
export function getWideEvent(): WideEvent | undefined {
  return eventStorage.getStore();
}

/**
 * Determine if the event should be sampled.
 * Takes finalized WideEventData to ensure status_code and duration_ms are available.
 * @internal
 */
export function shouldSample(data: WideEventData): boolean {
  // skip assets
  if (data.path) {
    const skipPaths = [
      "/@vite/",
      "/@fs/",
      "/node_modules/",
      "/src/",
      "/@react-refresh",
    ];

    if (skipPaths.some((path) => data.path?.startsWith(path))) return false;

    // skip by extension
    if (
      /\.(js|css|json|svg|png|jpg|jpeg|gif|ico|webp|woff|woff2|ttf|eot|otf)$/.test(
        data.path,
      )
    ) {
      return false;
    }
  }

  // always keep errors
  if (data.status_code && data.status_code >= 400) return true;
  if (data.error) return true;

  // always keep slow requests (> 10s)
  if (data.duration_ms && data.duration_ms > 10000) return true;

  // always keep retried requests
  if (data.execution?.retry_attempts && data.execution.retry_attempts > 0)
    return true;

  // random sample the rest
  return Math.random() < SAMPLING_RATE;
}

/**
 * Format WideEvent to terminal output.
 * @internal - Used by LoggerManager
 */
export function formatAndEmitWideEvent(
  event: WideEvent,
  statusCode: number,
): WideEventData | null {
  // Finalize FIRST to set status_code and duration_ms
  const data = event.finalize(statusCode);

  // THEN check sampling (now has access to status_code, duration_ms)
  if (!shouldSample(data)) return null;

  // Format and output to terminal
  const output = IS_PRODUCTION ? formatJson(data) : formatPretty(data);
  debug(output);

  return data;
}
