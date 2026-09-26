import express from "express";

import { createLogger } from "../../logging/logger";

const logger = createLogger("server:app-analytics");

/**
 * Same-origin path that the App Analytics browser SDK
 * (`@databricks/app-analytics`) posts OTLP/HTTP JSON log batches to by default.
 */
export const APP_ANALYTICS_PATH = "/_analytics/v1/logs";

/**
 * Prefix of every path App Analytics owns on the server. These requests carry
 * only the browser's records, so AppKit records no request metrics for them.
 */
export const APP_ANALYTICS_PATH_PREFIX = "/_analytics/";

/**
 * Largest body the relay accepts. The browser SDK never sends more than
 * 48 KiB per request.
 */
const APP_ANALYTICS_BODY_LIMIT = "64kb";

/** Upper bound for one forward to the OTel Collector. */
const FORWARD_TIMEOUT_MS = 5_000;

/**
 * Resolve the OTel Collector logs endpoint the way the OTLP exporters do: a
 * signal-specific `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` is used as-is, otherwise
 * `/v1/logs` is appended to `OTEL_EXPORTER_OTLP_ENDPOINT`.
 *
 * Databricks Apps sets these only when App telemetry is enabled, so
 * `undefined` means there is no collector to forward to.
 */
export function resolveOtlpLogsEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const logsEndpoint = env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
  if (logsEndpoint) return logsEndpoint;

  const baseEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!baseEndpoint) return undefined;

  return `${baseEndpoint.replace(/\/$/, "")}/v1/logs`;
}

/**
 * POST an OTLP/HTTP JSON payload to the collector and return the collector's
 * status code. The payload is serialized as-is, no incoming request headers
 * are forwarded, and redirects are not followed.
 *
 * @throws When the collector can't be reached or doesn't answer within
 * 5 seconds.
 */
export async function forwardOtlpLogs(
  payload: unknown,
  endpoint: string,
): Promise<number> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    redirect: "manual",
    signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
  });

  try {
    // Only the status is relayed, so release the connection right away.
    await response.body?.cancel();
  } catch {
    // Response cleanup must not replace the collector status.
  }

  return response.status;
}

/**
 * Request guard for {@link APP_ANALYTICS_PATH}, mounted ahead of
 * {@link appAnalyticsRelay}. It parses the body itself, so the path must be
 * skipped by the server's global JSON parser.
 *
 * - `415` when the body isn't `application/json`
 * - `413` when the body is over {@link APP_ANALYTICS_BODY_LIMIT}
 * - `400` when the body isn't valid JSON or `resourceLogs` isn't an array
 *
 * Every rejection is answered here with an empty body, so the server's error
 * handler neither sees nor logs it. Only the exact path passes: Express routing
 * also matches other letter cases and a trailing slash, but those paths go
 * through the global parser and its larger limit.
 */
export function appAnalyticsGuard(): Array<
  express.RequestHandler | express.ErrorRequestHandler
> {
  const requireJson: express.RequestHandler = (req, res, next) => {
    if (req.path !== APP_ANALYTICS_PATH) {
      next("route");
      return;
    }
    if (!req.is("application/json")) {
      res.status(415).end();
      return;
    }
    next();
  };

  const answerParseError: express.ErrorRequestHandler = (
    error,
    _req,
    res,
    next,
  ) => {
    const status = clientErrorStatus(error);
    if (status === undefined) {
      next(error);
      return;
    }
    res.status(status).end();
  };

  const requireOtlpLogs: express.RequestHandler = (req, res, next) => {
    if (!Array.isArray(req.body?.resourceLogs)) {
      res.status(400).end();
      return;
    }
    next();
  };

  return [
    requireJson,
    express.json({ limit: APP_ANALYTICS_BODY_LIMIT }),
    answerParseError,
    requireOtlpLogs,
  ];
}

/**
 * Route handler for {@link APP_ANALYTICS_PATH}, mounted after
 * {@link appAnalyticsGuard}.
 *
 * Relays the parsed JSON body to the OTel Collector and answers with the
 * collector's status and an empty body, or 502 when the collector can't be
 * reached, logging one warning on the first such failure. When App telemetry
 * is off there is no collector: the handler answers 204 so the browser SDK
 * neither retries nor reports a failure, discards the records, and logs one
 * warning.
 */
export function appAnalyticsRelay(): express.RequestHandler {
  let warnedTelemetryOff = false;
  let warnedForwardFailed = false;

  return async (req, res) => {
    const endpoint = resolveOtlpLogsEndpoint();
    if (endpoint === undefined) {
      if (!warnedTelemetryOff) {
        warnedTelemetryOff = true;
        logger.warn(
          "App telemetry is off (OTEL_EXPORTER_OTLP_ENDPOINT is not set), so App Analytics records sent to %s are discarded",
          APP_ANALYTICS_PATH,
        );
      }
      res.status(204).end();
      return;
    }

    try {
      res.status(await forwardOtlpLogs(req.body, endpoint)).end();
    } catch (error) {
      if (!warnedForwardFailed) {
        warnedForwardFailed = true;
        logger.warn(
          "Could not forward App Analytics records to the OTel Collector at %s (%s), so the relay answers 502. Later failures are not logged",
          endpoint,
          describeForwardError(error),
        );
      }
      res.status(502).end();
    }
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

/** A short reason for a failed forward, including the network cause. */
function describeForwardError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.name === "TimeoutError") {
    return `no answer within ${FORWARD_TIMEOUT_MS} ms`;
  }
  return error.cause instanceof Error
    ? `${error.message}: ${error.cause.message}`
    : error.message;
}
