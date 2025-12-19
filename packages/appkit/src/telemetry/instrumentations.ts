import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import type { Instrumentation } from "@opentelemetry/instrumentation";

/**
 * Registry of pre-configured instrumentations for common use cases.
 * These can be selectively registered by plugins that need them.
 *
 * While instrumentations are generally safe to re-register,
 * the recommended approach is to register them once in a corresponding plugin constructor.
 */
export const instrumentations: Record<string, Instrumentation> = {
  http: new HttpInstrumentation({
    applyCustomAttributesOnSpan(span: any, request: any) {
      let spanName: string | null = null;

      if (request.route) {
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
