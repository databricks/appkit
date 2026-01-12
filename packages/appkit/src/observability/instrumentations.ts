import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";

/**
 * Check if request path should be ignored (assets, static files)
 */
function shouldIgnorePath(path: string): boolean {
  // Skip Vite dev server paths
  const skipPaths = [
    "/@vite/",
    "/@fs/",
    "/node_modules/",
    "/src/",
    "/@react-refresh",
  ];
  if (skipPaths.some((skipPath) => path.startsWith(skipPath))) {
    return true;
  }

  // Skip static assets by extension
  if (
    /\.(js|css|json|svg|png|jpg|jpeg|gif|ico|webp|woff|woff2|ttf|eot|otf|map)$/.test(
      path,
    )
  ) {
    return true;
  }

  return false;
}

export const httpInstrumentation = new HttpInstrumentation({
  ignoreIncomingRequestHook: (request) => {
    const path = request.url || "";
    return shouldIgnorePath(path);
  },
  applyCustomAttributesOnSpan: (span: any, request: any) => {
    let spanName: string | null = null;
    if (request.route) {
      const baseURL = request.baseUrl || "";
      const url = request.url?.split("?")[0] || "";
      const fullPath = baseURL + url;
      if (fullPath) {
        spanName = `${request.method} ${fullPath}`;
      }
    } else if (request.url) {
      const path = request.path.split("?")[0];
      spanName = `${request.method} ${path}`;
    }

    if (spanName) {
      span.updateName(spanName);
    }
  },
});

export const expressInstrumentation = new ExpressInstrumentation({
  requestHook: (span: any, info: any) => {
    const req = info.request;
    if (info.layerType === "request_handler" && req.route) {
      const baseURL = req.baseUrl || "";
      const url = req.url?.split("?")[0] || "";
      const fullPath = baseURL + url;
      if (fullPath) {
        span.updateName(`${req.method} ${fullPath}`);
      }
    }
  },
});
