import type { Instrumentation } from "@opentelemetry/instrumentation";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";

import { shouldIgnoreRequest } from "../utils/path-exclusions";
import { routedPath } from "../utils/routed-path";

/** Named database operations carry their GET input in the query string. */
const OPERATIONS_MOUNT = "/api/database/operations";

/**
 * Keep an operation request's server span to its path, under either HTTP
 * semantic convention. Express routes case-insensitively and serves the mount
 * itself, so the match does too. Returns the path, or undefined for any other
 * request.
 */
function redactOperationQuery(span: any, request: any): string | undefined {
  const original: unknown = request.originalUrl;
  if (typeof original !== "string") return undefined;
  const path = routedPath(original);
  const lower = path.toLowerCase();
  if (lower !== OPERATIONS_MOUNT && !lower.startsWith(`${OPERATIONS_MOUNT}/`)) {
    return undefined;
  }
  const attributes = span.attributes ?? {};
  for (const key of ["http.url", "http.target", "url.full"]) {
    const value = attributes[key];
    if (typeof value === "string") span.setAttribute(key, value.split("?")[0]);
  }
  if (typeof attributes["url.query"] === "string") {
    span.setAttribute("url.query", "REDACTED");
  }
  return path;
}

/**
 * Registry of pre-configured instrumentations for common use cases.
 * These can be selectively registered by plugins that need them.
 *
 * While instrumentations are generally safe to re-register,
 * the recommended approach is to register them once in a corresponding plugin constructor.
 */
export const instrumentations: Record<string, Instrumentation> = {
  http: new HttpInstrumentation({
    // Filter out requests before creating spans - this is the most efficient approach
    ignoreIncomingRequestHook: shouldIgnoreRequest,

    applyCustomAttributesOnSpan(span: any, request: any) {
      let spanName: string | null = null;
      const operationPath = redactOperationQuery(span, request);

      if (operationPath) {
        spanName = `${request.method} ${operationPath}`;
      } else if (request.route) {
        const baseUrl = request.baseUrl || "";
        const url = request.url?.split("?")[0] || "";
        const fullPath = baseUrl + url;
        if (fullPath) {
          spanName = `${request.method} ${fullPath}`;
        }
      } else if (request.url) {
        // No Express route (e.g., static assets) - use the raw URL path
        // Remove query string for cleaner trace names
        const path = request.url.split("?")[0];
        spanName = `${request.method} ${path}`;
      }

      if (spanName) {
        span.updateName(spanName);
      }
    },
  }),
  express: new ExpressInstrumentation({
    requestHook: (span: any, info: any) => {
      const req = info.request;

      // Only update span name for route handlers (layerType: request_handler)
      // This ensures we're not renaming middleware spans
      if (info.layerType === "request_handler" && req.route) {
        // Combine baseUrl with url to get full path with actual parameter values
        // e.g., baseUrl="/api/analytics" + url="/query/spend_data" = "/api/analytics/query/spend_data"
        const baseUrl = req.baseUrl || "";
        const url = req.url?.split("?")[0] || "";
        const fullPath = baseUrl + url;
        if (fullPath) {
          const spanName = `${req.method} ${fullPath}`;
          span.updateName(spanName);
        }
      }
    },
  }),
};
