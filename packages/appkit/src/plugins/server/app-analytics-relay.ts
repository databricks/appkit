import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type Counter, context, type Meter } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import express from "express";

import { createLogger } from "../../logging/logger";
import {
  type OtlpLogsExport,
  resolveOtlpLogsExport,
} from "../../telemetry/otlp-logs-export";
import {
  APP_ANALYTICS_PATH,
  APP_ANALYTICS_SDK_PATH,
} from "../../utils/app-analytics-paths";
import type { AppAnalyticsBrowserOptions, ServerConfig } from "./types";

export { APP_ANALYTICS_PATH, APP_ANALYTICS_SDK_PATH };

const logger = createLogger("server:app-analytics");

/**
 * Where the build copies `@databricks/app-analytics`'s `dist/browser/sdk.js`:
 * next to this module, in `dist/plugins/server/app-analytics/`. The published
 * package carries the file, so it has no npm dependency on the library.
 */
const DEFAULT_SDK_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "app-analytics",
  "sdk.js",
);

/**
 * Largest body the relay accepts. The browser SDK never sends more than
 * 48 KiB per request; the integration test drives the SDK's largest batches
 * through the relay to keep the two in step.
 */
const APP_ANALYTICS_BODY_LIMIT = "64kb";

/**
 * Most log records one request may carry. The browser SDK sends at most 25.
 * The cap bounds the rows one request can write, independently of the byte
 * limit (64 KiB of minimal records is about 20,000 of them).
 */
const MAX_RECORDS_PER_REQUEST = 100;

/** Upper bound for one forward to the OTel Collector. */
const FORWARD_TIMEOUT_MS = 5_000;

/**
 * Forwards in flight at once. Each one holds its body for up to
 * {@link FORWARD_TIMEOUT_MS}, so a slow collector can't pile up requests.
 */
const DEFAULT_MAX_CONCURRENT_FORWARDS = 16;

/** `Retry-After`, in seconds, for answers the relay gives on its own. */
const RELAY_RETRY_AFTER_SECONDS = 1;

/** Largest collector response body read for a partial-success count. */
const MAX_COLLECTOR_RESPONSE_BYTES = 4 * 1024;

/** Minimum time between two warnings of the same kind. */
const WARNING_INTERVAL_MS = 60_000;

/**
 * What happened to one relay request. Low cardinality, so it is safe as a
 * metric attribute.
 */
type RelayOutcome =
  /** The collector accepted the records. */
  | "forwarded"
  /** The collector accepted the request but rejected some records. */
  | "partially_rejected"
  /** The collector rejected the records (400, 413). */
  | "rejected"
  /** The collector asked the browser to retry later (408, 429). */
  | "throttled"
  /** The collector failed (5xx). */
  | "collector_error"
  /**
   * The collector answered in a way that means the relay is misconfigured
   * (3xx, 401, 403, 404, ...). Answered with 502.
   */
  | "misconfigured"
  /** The collector can't be reached or didn't answer in time. */
  | "unreachable"
  /** Too many forwards in flight. Answered with 503. */
  | "overloaded"
  /** Cancelled because the server is shutting down. Answered with 503. */
  | "aborted"
  /** App telemetry is off, so the records are discarded. Answered with 204. */
  | "discarded"
  /** The request isn't an OTLP logs body the relay accepts. */
  | "invalid";

/** The part of AppKit's telemetry the relay uses. */
interface RelayTelemetry {
  getMeter(): Meter;
}

/** Options of {@link createAppAnalyticsRelay}. */
export interface AppAnalyticsRelayOptions {
  /**
   * Telemetry to count relay outcomes with, as
   * `app_analytics.relay.requests{outcome, http.response.status_code}`.
   */
  telemetry?: RelayTelemetry;
  /** Environment to resolve the collector from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Forwards in flight at once before the relay answers 503. */
  maxConcurrentForwards?: number;
  /** Clock for warning intervals. Defaults to `Date.now`. */
  now?: () => number;
}

/** The mounted relay. */
export interface AppAnalyticsRelay {
  /** Handlers to mount with `app.post(APP_ANALYTICS_PATH, ...handlers)`. */
  handlers: Array<express.RequestHandler | express.ErrorRequestHandler>;
  /**
   * Cancel forwards in flight and answer later requests with 503, so the
   * browser retries once the server is back. Called on shutdown.
   */
  abort(): void;
}

/** What a forward to the collector returned. */
interface ForwardResult {
  status: number;
  /** The collector's `Retry-After`, when it is a valid value. */
  retryAfter?: string;
  /** `partialSuccess.rejectedLogRecords` from the collector's answer. */
  rejectedLogRecords?: number;
}

/**
 * Resolve the OTel Collector logs endpoint from the OpenTelemetry environment
 * variables, or `undefined` when App telemetry is off. See
 * {@link resolveOtlpLogsExport}.
 */
export function resolveOtlpLogsEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return resolveOtlpLogsExport(env)?.url;
}

/**
 * POST an OTLP/HTTP JSON body to the collector, byte for byte, and return its
 * answer. No incoming request header is forwarded, redirects are not followed,
 * and the request creates no span, so relayed browser traffic stays out of the
 * app's traces.
 *
 * @throws When the collector can't be reached, doesn't answer within 5
 * seconds, or `signal` aborts.
 */
export async function forwardOtlpLogs(
  body: Uint8Array,
  target: OtlpLogsExport,
  signal?: AbortSignal,
): Promise<ForwardResult> {
  const timeout = AbortSignal.timeout(FORWARD_TIMEOUT_MS);
  const response = await context.with(suppressTracing(context.active()), () =>
    fetch(target.url, {
      method: "POST",
      headers: { ...target.headers, "content-type": "application/json" },
      body,
      redirect: "manual",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    }),
  );

  const result: ForwardResult = { status: response.status };
  const retryAfter = readRetryAfter(response.headers.get("retry-after"));
  if (retryAfter !== undefined) result.retryAfter = retryAfter;

  const rejectedLogRecords = await readRejectedLogRecords(response);
  if (rejectedLogRecords !== undefined) {
    result.rejectedLogRecords = rejectedLogRecords;
  }
  return result;
}

/**
 * The App Analytics relay for {@link APP_ANALYTICS_PATH}. It checks that the
 * request is an OTLP logs body, forwards the body unchanged to the OTel
 * Collector, and answers with an empty body:
 *
 * - `415` when the body isn't UTF-8 `application/json`
 * - `413` when the body is over 64 KiB or carries over 100 records
 * - `400` when the body isn't JSON or isn't shaped like OTLP logs
 * - `204` when App telemetry is off: the records are discarded, so the browser
 *   neither retries nor reports a failure
 * - the collector's status for 2xx, 400, 408, 413, 429, and 5xx, with its
 *   `Retry-After`
 * - `502` when the collector can't be reached, or answers with a status that
 *   means the relay is misconfigured (3xx, 401, 403, 404, ...)
 * - `503` with `Retry-After` when too many forwards are in flight or the
 *   server is shutting down
 *
 * The relay checks only the OTLP envelope, never the App Analytics schema.
 * Collector problems are logged at most once a minute per kind, with a count
 * of the ones left out, and logged again as soon as the collector recovers
 * and fails again.
 *
 * The relay parses its own body, so the path must be skipped by the server's
 * global JSON parser. Only the exact path is handled: Express routing also
 * matches other letter cases and a trailing slash, but those requests go
 * through the global parser and are left to later routes.
 *
 * Requiring `application/json` is also the relay's CSRF defence: a
 * cross-origin page can only send it after a CORS preflight, which the server
 * never allows.
 */
export function createAppAnalyticsRelay(
  options: AppAnalyticsRelayOptions = {},
): AppAnalyticsRelay {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const maxConcurrentForwards =
    options.maxConcurrentForwards ?? DEFAULT_MAX_CONCURRENT_FORWARDS;
  const shutdown = new AbortController();
  let inFlight = 0;
  let warnedTelemetryOff = false;

  // Created on first use: the meter provider is registered after plugins are
  // constructed, and an instrument bound before that stays a no-op.
  let requests: Counter | undefined;
  const count = (outcome: RelayOutcome, status: number) => {
    requests ??= options.telemetry
      ?.getMeter()
      .createCounter("app_analytics.relay.requests", {
        description: "App Analytics relay requests, by outcome",
      });
    requests?.add(1, { outcome, "http.response.status_code": status });
  };

  const collectorWarning = throttledWarning(now);
  const partialWarning = throttledWarning(now);
  const overloadWarning = throttledWarning(now);
  const parserWarning = throttledWarning(now);

  const answer = (
    res: express.Response,
    status: number,
    outcome: RelayOutcome,
    retryAfter?: string,
  ) => {
    count(outcome, status);
    if (retryAfter !== undefined) res.set("Retry-After", retryAfter);
    res.status(status).end();
  };

  const requireJson: express.RequestHandler = (req, res, next) => {
    if (req.path !== APP_ANALYTICS_PATH) {
      next("route");
      return;
    }
    if (!req.is("application/json") || !isUtf8(req.headers["content-type"])) {
      answer(res, 415, "invalid");
      return;
    }
    next();
  };

  const answerParseError: express.ErrorRequestHandler = (
    error,
    _req,
    res,
    _next,
  ) => {
    const status = clientErrorStatus(error);
    if (status !== undefined) {
      answer(res, status, "invalid");
      return;
    }
    parserWarning.warn(
      "Could not read an App Analytics request body (%s), so the relay answers 500",
      error instanceof Error ? error.message : String(error),
    );
    answer(res, 500, "invalid");
  };

  const requireOtlpLogs: express.RequestHandler = (req, res, next) => {
    const body = parseOtlpLogs(req.body);
    if (body === "invalid") {
      answer(res, 400, "invalid");
      return;
    }
    if (body === "too_many_records") {
      answer(res, 413, "invalid");
      return;
    }
    res.locals.appAnalyticsBody = body;
    next();
  };

  const relay: express.RequestHandler = async (_req, res) => {
    const target = resolveOtlpLogsExport(env);
    if (target === undefined) {
      if (!warnedTelemetryOff) {
        warnedTelemetryOff = true;
        logger.warn(
          "App telemetry is off (neither OTEL_EXPORTER_OTLP_ENDPOINT nor OTEL_EXPORTER_OTLP_LOGS_ENDPOINT is set), so App Analytics records sent to %s are discarded",
          APP_ANALYTICS_PATH,
        );
      }
      answer(res, 204, "discarded");
      return;
    }

    if (shutdown.signal.aborted) {
      answer(res, 503, "aborted", String(RELAY_RETRY_AFTER_SECONDS));
      return;
    }
    if (inFlight >= maxConcurrentForwards) {
      overloadWarning.warn(
        "The App Analytics relay has %d forwards in flight, so it answers 503 until one finishes",
        inFlight,
      );
      answer(res, 503, "overloaded", String(RELAY_RETRY_AFTER_SECONDS));
      return;
    }

    const collector = describeEndpoint(target.url);
    inFlight += 1;
    try {
      const result = await forwardOtlpLogs(
        res.locals.appAnalyticsBody as Buffer,
        target,
        shutdown.signal,
      );
      const { status, outcome } = classifyCollectorStatus(result.status);

      if (outcome === "forwarded") {
        collectorWarning.recovered(
          "The OTel Collector at %s accepts App Analytics records again",
          collector,
        );
      } else {
        collectorWarning.warn(
          collectorStatusMessage(outcome),
          collector,
          result.status,
        );
      }

      const rejected = result.rejectedLogRecords ?? 0;
      if (outcome === "forwarded" && rejected > 0) {
        partialWarning.warn(
          "The OTel Collector at %s rejected %d App Analytics records of an accepted request",
          collector,
          rejected,
        );
        answer(res, status, "partially_rejected");
        return;
      }

      const retryAfter =
        status === 429 || status === 503 ? result.retryAfter : undefined;
      answer(res, status, outcome, retryAfter);
    } catch (error) {
      if (shutdown.signal.aborted) {
        answer(res, 503, "aborted", String(RELAY_RETRY_AFTER_SECONDS));
        return;
      }
      collectorWarning.warn(
        "Could not reach the OTel Collector at %s (%s), so the relay answers 502",
        collector,
        describeForwardError(error),
      );
      answer(res, 502, "unreachable");
    } finally {
      inFlight -= 1;
    }
  };

  return {
    handlers: [
      requireJson,
      express.raw({ limit: APP_ANALYTICS_BODY_LIMIT, type: () => true }),
      answerParseError,
      requireOtlpLogs,
      relay,
    ],
    abort: () => shutdown.abort(),
  };
}

/** How the relay answers a collector status, and what it means. */
function classifyCollectorStatus(status: number): {
  status: number;
  outcome: RelayOutcome;
} {
  if (status >= 200 && status < 300) return { status, outcome: "forwarded" };
  if (status === 400 || status === 413) return { status, outcome: "rejected" };
  if (status === 408 || status === 429) return { status, outcome: "throttled" };
  if (status >= 500 && status < 600) {
    return { status, outcome: "collector_error" };
  }
  // 3xx, 401, 403, 404, ...: the browser can't fix these, the app owner can.
  return { status: 502, outcome: "misconfigured" };
}

function collectorStatusMessage(outcome: RelayOutcome): string {
  switch (outcome) {
    case "rejected":
      return "The OTel Collector at %s rejected App Analytics records (HTTP %d)";
    case "throttled":
      return "The OTel Collector at %s asked App Analytics to retry later (HTTP %d)";
    case "misconfigured":
      return "The OTel Collector at %s answered HTTP %d, which means the App Analytics relay is misconfigured, so the relay answers 502. Check the endpoint, protocol, and credentials";
    default:
      return "The OTel Collector at %s failed to accept App Analytics records (HTTP %d)";
  }
}

/**
 * Warn at most once per {@link WARNING_INTERVAL_MS}, counting the warnings
 * left out. After {@link recovered}, the next warning is logged right away.
 */
function throttledWarning(now: () => number) {
  let lastWarnedAt: number | undefined;
  let suppressed = 0;
  let failing = false;

  return {
    warn(message: string, ...args: unknown[]): void {
      failing = true;
      const time = now();
      if (
        lastWarnedAt !== undefined &&
        time - lastWarnedAt < WARNING_INTERVAL_MS
      ) {
        suppressed += 1;
        return;
      }
      if (suppressed > 0) {
        logger.warn(
          `${message}. %d similar warnings since the previous one were not logged`,
          ...args,
          suppressed,
        );
      } else {
        logger.warn(message, ...args);
      }
      lastWarnedAt = time;
      suppressed = 0;
    },
    recovered(message: string, ...args: unknown[]): void {
      if (!failing) return;
      failing = false;
      lastWarnedAt = undefined;
      suppressed = 0;
      logger.info(message, ...args);
    },
  };
}

/** Whether a `Content-Type` declares no charset or UTF-8. */
function isUtf8(contentType: string | undefined): boolean {
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(contentType ?? "");
  return charset === null || charset[1].toLowerCase() === "utf-8";
}

/**
 * The body as bytes to forward, or why it can't be forwarded. Only the OTLP
 * envelope is checked: `resourceLogs[].scopeLogs[].logRecords[]` must be
 * arrays of objects, with at most {@link MAX_RECORDS_PER_REQUEST} records.
 */
function parseOtlpLogs(raw: unknown): Buffer | "invalid" | "too_many_records" {
  if (!Buffer.isBuffer(raw) || raw.length === 0) return "invalid";

  let body: Buffer = raw;
  // A UTF-8 byte order mark isn't JSON; forward the body without it.
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
    body = body.subarray(3);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return "invalid";
  }

  const resourceLogs = isRecord(parsed) ? parsed.resourceLogs : undefined;
  if (!Array.isArray(resourceLogs)) return "invalid";

  let records = 0;
  for (const resourceLog of resourceLogs) {
    if (!isRecord(resourceLog)) return "invalid";
    const scopeLogs = resourceLog.scopeLogs ?? [];
    if (!Array.isArray(scopeLogs)) return "invalid";
    for (const scopeLog of scopeLogs) {
      if (!isRecord(scopeLog)) return "invalid";
      const logRecords = scopeLog.logRecords ?? [];
      if (!Array.isArray(logRecords)) return "invalid";
      for (const logRecord of logRecords) {
        if (!isRecord(logRecord)) return "invalid";
      }
      records += logRecords.length;
      if (records > MAX_RECORDS_PER_REQUEST) return "too_many_records";
    }
  }
  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The collector's `Retry-After`, if it is delay-seconds or an HTTP date
 * (`Wed, 21 Oct 2015 07:28:00 GMT`).
 */
function readRetryAfter(value: string | null): string | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d{1,10}$/.test(trimmed)) return trimmed;
  const isHttpDate =
    /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
      trimmed,
    ) && !Number.isNaN(Date.parse(trimmed));
  return isHttpDate ? trimmed : undefined;
}

/**
 * `partialSuccess.rejectedLogRecords` from a JSON collector answer, reading at
 * most {@link MAX_COLLECTOR_RESPONSE_BYTES}. The rest of the body is released.
 */
async function readRejectedLogRecords(
  response: Response,
): Promise<number | undefined> {
  const body = response.body;
  if (body === null) return undefined;

  const reader = body.getReader();
  try {
    if (!response.headers.get("content-type")?.includes("json")) {
      return undefined;
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_COLLECTOR_RESPONSE_BYTES) return undefined;
      chunks.push(value);
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const partial = isRecord(parsed) ? parsed.partialSuccess : undefined;
    const rejected = isRecord(partial) ? partial.rejectedLogRecords : undefined;
    // OTLP/JSON encodes int64 as a string.
    const count = typeof rejected === "string" ? Number(rejected) : rejected;
    return typeof count === "number" && Number.isSafeInteger(count)
      ? count
      : undefined;
  } catch {
    return undefined;
  } finally {
    // Only the status and counts are relayed; release the connection.
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * Whether the server adds the {@link APP_ANALYTICS_SDK_PATH} script tag to
 * `index.html`: App Analytics isn't turned off and App telemetry is on. Without
 * a collector the relay discards every record, so local development without
 * `OTEL_EXPORTER_OTLP_ENDPOINT` gets no script and no traffic.
 */
export function shouldInjectSdk(
  config: Pick<ServerConfig, "appAnalytics">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    config.appAnalytics !== false && resolveOtlpLogsEndpoint(env) !== undefined
  );
}

/**
 * The browser-safe part of `server({ appAnalytics })`, as it goes into
 * `window.__appkit__.appAnalytics`. Only known options with the right type
 * reach the page.
 */
export function appAnalyticsBrowserOptions(
  appAnalytics: ServerConfig["appAnalytics"],
): AppAnalyticsBrowserOptions {
  const options: AppAnalyticsBrowserOptions = {};
  if (typeof appAnalytics !== "object" || appAnalytics === null) {
    return options;
  }

  const { autocapture, sampleRate, webVitals } = appAnalytics;
  if (typeof webVitals === "boolean") options.webVitals = webVitals;
  if (typeof autocapture === "boolean") options.autocapture = autocapture;
  if (typeof sampleRate === "number" && Number.isFinite(sampleRate)) {
    options.sampleRate = sampleRate;
  }
  return options;
}

/**
 * Route handler for {@link APP_ANALYTICS_SDK_PATH}. Answers with the
 * self-contained App Analytics build as `text/javascript`, read once from
 * `file`, or 404 and one warning when the file is missing. The URL carries no
 * version, so browsers revalidate it on every load.
 *
 * @param file - Path of the build. Defaults to the copy next to the compiled
 * server plugin.
 */
export function serveSdk(
  file: string = DEFAULT_SDK_FILE,
): express.RequestHandler {
  let source: Buffer | undefined;
  let warnedMissing = false;

  return (_req, res) => {
    try {
      source ??= fs.readFileSync(file);
    } catch (error) {
      if (!warnedMissing) {
        warnedMissing = true;
        logger.warn(
          "Could not read the App Analytics browser build at %s (%s), so %s answers 404",
          file,
          error instanceof Error ? error.message : String(error),
          APP_ANALYTICS_SDK_PATH,
        );
      }
      res.status(404).end();
      return;
    }

    res.set({
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    res.send(source);
  };
}

/** The 4xx status a body-parser error carries, if any. */
function clientErrorStatus(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && status >= 400 && status < 500
    ? status
    : undefined;
}

/** The collector endpoint for logs, without credentials or a query string. */
function describeEndpoint(url: string): string {
  try {
    const { origin, pathname } = new URL(url);
    return `${origin}${pathname}`;
  } catch {
    return "(invalid URL)";
  }
}

/**
 * A short reason for a failed forward, including the network cause. URLs in
 * it lose their credentials and query string: `fetch` quotes the full URL when
 * it refuses one.
 */
function describeForwardError(error: unknown): string {
  if (!(error instanceof Error)) return redactUrls(String(error));
  if (error.name === "TimeoutError") {
    return `no answer within ${FORWARD_TIMEOUT_MS} ms`;
  }
  return redactUrls(
    error.cause instanceof Error
      ? `${error.message}: ${error.cause.message}`
      : error.message,
  );
}

function redactUrls(message: string): string {
  return message.replace(/\bhttps?:\/\/\S+/gi, (url) => {
    const trailing = /[.,;:)]+$/.exec(url)?.[0] ?? "";
    return (
      describeEndpoint(url.slice(0, url.length - trailing.length)) + trailing
    );
  });
}
