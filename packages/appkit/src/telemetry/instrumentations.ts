import type { Instrumentation } from "@opentelemetry/instrumentation";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { shouldIgnoreRequest } from "../utils/path-exclusions";

/**
 * Factory functions that create pre-configured instrumentations on demand.
 * Lazy creation avoids side-effects at import time (e.g. module patching
 * triggered by instrumentation constructors).
 */
export const instrumentations = {
  http: (): Instrumentation =>
    new HttpInstrumentation({
      ignoreIncomingRequestHook: shouldIgnoreRequest,

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

  express: (): Instrumentation =>
    new ExpressInstrumentation({
      requestHook: (span: any, info: any) => {
        const req = info.request;

        if (info.layerType === "request_handler" && req.route) {
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
