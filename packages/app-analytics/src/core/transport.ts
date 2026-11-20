import type { BrowserEvent } from "./event";
import { encodeOtlp } from "./otlp-json";

export const MAX_EVENTS_PER_BATCH = 25;
export const MAX_BATCH_BODY_BYTES = 48 * 1024;
export const REQUEST_TIMEOUT_MS = 10_000;

export interface PreparedEventBatch {
  readonly kind: "batch";
  readonly events: readonly BrowserEvent[];
  readonly body: string;
  readonly byteLength: number;
}

type PreparedBatch =
  | PreparedEventBatch
  | {
      readonly kind: "oversized";
      readonly event: BrowserEvent;
      readonly byteLength: number;
    }
  | { readonly kind: "empty" }
  | {
      readonly kind: "encoding_error";
      readonly event: BrowserEvent;
    };

export type DeliveryResult =
  | { readonly outcome: "accepted"; readonly status?: number }
  | {
      readonly outcome: "retryable";
      readonly reason: "network" | "timeout" | "http";
      readonly status?: number;
      /** Delay requested by a `Retry-After` response header. */
      readonly retryAfterMs?: number;
    }
  | {
      readonly outcome: "rejected";
      readonly reason: "http" | "unavailable";
      readonly status?: number;
    };

interface SendBatchOptions {
  readonly keepalive?: boolean;
  readonly timeoutMs?: number;
}

interface EncodedBatch {
  readonly body: string;
  readonly byteLength: number;
}

const TIMED_OUT = Symbol("app-analytics-request-timeout");

/**
 * Encodes the largest FIFO prefix allowed by the event-count and byte limits.
 * An event that cannot fit by itself is returned intact so the delivery layer
 * can drop it explicitly and continue with the rest of the queue.
 */
export function prepareBatch(events: readonly BrowserEvent[]): PreparedBatch {
  const firstEvent = events[0];
  if (firstEvent === undefined) return { kind: "empty" };

  const first = tryEncode(events.slice(0, 1));
  if (first === undefined) {
    return { kind: "encoding_error", event: firstEvent };
  }
  if (first.byteLength > MAX_BATCH_BODY_BYTES) {
    return {
      kind: "oversized",
      event: firstEvent,
      byteLength: first.byteLength,
    };
  }

  const candidateCount = Math.min(events.length, MAX_EVENTS_PER_BATCH);
  if (candidateCount === 1) {
    return toPreparedBatch(events, 1, first);
  }

  const candidate = tryEncode(events.slice(0, candidateCount));
  if (candidate !== undefined && candidate.byteLength <= MAX_BATCH_BODY_BYTES) {
    return toPreparedBatch(events, candidateCount, candidate);
  }

  // Adding an event always increases the encoded JSON size. A failed encode
  // also excludes every larger prefix because it contains the same event.
  let largestCount = 1;
  let largestEncoding = first;
  let lowerBound = 2;
  let upperBound = candidateCount - 1;

  while (lowerBound <= upperBound) {
    const count = Math.floor((lowerBound + upperBound) / 2);
    const encoded = tryEncode(events.slice(0, count));

    if (encoded !== undefined && encoded.byteLength <= MAX_BATCH_BODY_BYTES) {
      largestCount = count;
      largestEncoding = encoded;
      lowerBound = count + 1;
    } else {
      upperBound = count - 1;
    }
  }

  return toPreparedBatch(events, largestCount, largestEncoding);
}

/** Sends an already encoded batch and classifies every observable outcome. */
export async function sendBatch(
  endpoint: string,
  batch: PreparedEventBatch,
  options: SendBatchOptions = {},
): Promise<DeliveryResult> {
  const request = globalThis.fetch;
  if (typeof request !== "function") {
    return { outcome: "rejected", reason: "unavailable" };
  }

  const keepalive = options.keepalive ?? false;
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const controller = createAbortController();
  let didTimeout = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const requestPromise = Promise.resolve(
      request(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: batch.body,
        credentials: "same-origin",
        mode: "same-origin",
        redirect: "error",
        referrerPolicy: "no-referrer",
        cache: "no-store",
        keepalive,
        signal: controller?.signal,
      }),
    );
    const timeoutPromise = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => {
        didTimeout = true;
        resolve(TIMED_OUT);
        controller?.abort();
      }, timeoutMs);
    });

    const response = await Promise.race([requestPromise, timeoutPromise]);
    if (response === TIMED_OUT) {
      return { outcome: "retryable", reason: "timeout" };
    }

    return classifyResponse(response);
  } catch {
    return didTimeout
      ? { outcome: "retryable", reason: "timeout" }
      : { outcome: "retryable", reason: "network" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Attempts one bounded delivery while the page is unloading. Fetch remains
 * the preferred transport; Beacon is used only where fetch is unavailable.
 */
export async function sendBatchOnUnload(
  endpoint: string,
  batch: PreparedEventBatch,
): Promise<DeliveryResult> {
  try {
    if (typeof globalThis.fetch === "function") {
      return await sendBatch(endpoint, batch, { keepalive: true });
    }

    const beacon = globalThis.navigator?.sendBeacon;
    if (typeof beacon !== "function" || typeof globalThis.Blob !== "function") {
      return { outcome: "rejected", reason: "unavailable" };
    }

    const body = new Blob([batch.body], { type: "application/json" });
    return beacon.call(globalThis.navigator, endpoint, body)
      ? { outcome: "accepted" }
      : { outcome: "rejected", reason: "unavailable" };
  } catch {
    return { outcome: "rejected", reason: "unavailable" };
  }
}

function toPreparedBatch(
  events: readonly BrowserEvent[],
  count: number,
  encoded: EncodedBatch,
): PreparedEventBatch {
  return {
    kind: "batch",
    events: events.slice(0, count),
    body: encoded.body,
    byteLength: encoded.byteLength,
  };
}

function tryEncode(events: readonly BrowserEvent[]): EncodedBatch | undefined {
  try {
    const body = JSON.stringify(encodeOtlp(events));
    const encoder = new TextEncoder();
    return { body, byteLength: encoder.encode(body).byteLength };
  } catch {
    return undefined;
  }
}

function normalizeTimeout(timeoutMs: number | undefined): number {
  return typeof timeoutMs === "number" &&
    Number.isFinite(timeoutMs) &&
    timeoutMs >= 0
    ? timeoutMs
    : REQUEST_TIMEOUT_MS;
}

function createAbortController(): AbortController | undefined {
  try {
    return typeof globalThis.AbortController === "function"
      ? new AbortController()
      : undefined;
  } catch {
    return undefined;
  }
}

function classifyResponse(response: Response): DeliveryResult {
  const status = response.status;
  if (status >= 200 && status < 300) {
    return { outcome: "accepted", status };
  }
  if (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    (status >= 500 && status < 600)
  ) {
    const retryAfterMs = readRetryAfterMs(response);
    return retryAfterMs === undefined
      ? { outcome: "retryable", reason: "http", status }
      : { outcome: "retryable", reason: "http", status, retryAfterMs };
  }
  return { outcome: "rejected", reason: "http", status };
}

/** Parses `Retry-After` as delay-seconds or an HTTP date. */
function readRetryAfterMs(response: Response): number | undefined {
  let header: string | null | undefined;
  try {
    header = response.headers?.get("retry-after");
  } catch {
    return undefined;
  }
  if (typeof header !== "string" || header.trim().length === 0) {
    return undefined;
  }

  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1_000;

  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}
