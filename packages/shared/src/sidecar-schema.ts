/** Payload the FE sends to the sidecar endpoint. */
export interface StdioRequestPayload {
  /** The action/path the child process should handle (e.g., "/predict"). */
  path: string;
  /** HTTP method. Default: "POST". */
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** The request body — any valid JSON value. */
  body?: unknown;
}

/** Response shape from the child process. */
export interface StdioResponsePayload {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

/** Lightweight client-side validation (no Zod required). */
export function validateStdioRequest(
  payload: unknown,
):
  | { success: true; data: StdioRequestPayload }
  | { success: false; error: string } {
  if (typeof payload !== "object" || payload === null) {
    return { success: false, error: "Payload must be an object" };
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.path !== "string" || p.path.length === 0) {
    return { success: false, error: "path must be a non-empty string" };
  }
  const validMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"];
  if (p.method !== undefined && !validMethods.includes(p.method as string)) {
    return {
      success: false,
      error: `method must be one of: ${validMethods.join(", ")}`,
    };
  }
  return {
    success: true,
    data: {
      path: p.path,
      method: (p.method as StdioRequestPayload["method"]) ?? "POST",
      body: p.body,
    },
  };
}
