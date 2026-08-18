import type { WarehouseStatus } from "./types";

export const GENERIC_LOAD_ERROR = "Unable to load data, please try again";

export function getDevMode(): string {
  const dev = new URL(window.location.href).searchParams.get("dev");
  return dev ? `?dev=${dev}` : "";
}

/** Map a fetch/SSE transport error to a user-facing message. */
export function userFacingFetchError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return "Request timed out, please try again";
    }
    if (error.message.includes("Failed to fetch")) {
      return "Network error. Please check your connection.";
    }
  }
  return GENERIC_LOAD_ERROR;
}

interface WarehouseStatusMessage {
  kind: "warehouse-status";
  status: WarehouseStatus;
}

export interface AnalyticsSseResultMessage {
  kind: "result";
  data: unknown[];
  payload: Record<string, unknown>;
}

interface AnalyticsSseErrorMessage {
  kind: "error";
  message: string;
  errorCode: string | null;
  code: unknown;
}

interface InvalidAnalyticsSseMessage {
  kind: "invalid";
  reason: "malformed-warehouse-status" | "unrecognized";
  payload: unknown;
}

type AnalyticsSseMessage =
  | WarehouseStatusMessage
  | AnalyticsSseResultMessage
  | AnalyticsSseErrorMessage
  | InvalidAnalyticsSseMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWarehouseStatusPayload(value: unknown): value is WarehouseStatus {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as WarehouseStatus).state === "string"
  );
}

/**
 * Parse and classify the deliberately loose analytics SSE wire format.
 * Result rows normalize to an empty array so hook state remains `T | null`.
 */
export function parseAnalyticsSseMessage(
  data: string,
  defaultExecutionError: string,
): AnalyticsSseMessage {
  const parsed: unknown = JSON.parse(data);

  if (!isRecord(parsed)) {
    return { kind: "invalid", reason: "unrecognized", payload: parsed };
  }

  if (parsed.type === "warehouse_status") {
    if (!isWarehouseStatusPayload(parsed.status)) {
      return {
        kind: "invalid",
        reason: "malformed-warehouse-status",
        payload: parsed,
      };
    }
    return { kind: "warehouse-status", status: parsed.status };
  }

  if (parsed.type === "result") {
    return {
      kind: "result",
      data: Array.isArray(parsed.data) ? parsed.data : [],
      payload: parsed,
    };
  }

  if (parsed.type === "error" || parsed.error || parsed.code) {
    const message =
      (typeof parsed.error === "string" && parsed.error) ||
      (typeof parsed.message === "string" && parsed.message) ||
      defaultExecutionError;
    return {
      kind: "error",
      message,
      errorCode: typeof parsed.errorCode === "string" ? parsed.errorCode : null,
      code: parsed.code,
    };
  }

  return { kind: "invalid", reason: "unrecognized", payload: parsed };
}

export interface AnalyticsSseHandlerContext {
  source: "useAnalyticsQuery" | "useMetricView";
  resource: Record<string, unknown>;
  defaultExecutionError: string;
  unpublishOnMalformedMessage: boolean;
  signal: AbortSignal;
  abort: () => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setErrorCode: (code: string | null) => void;
  onWarehouseStatus: (status: WarehouseStatus) => void;
  onResult: (message: AnalyticsSseResultMessage) => void;
  unpublishWarehouseStatus: () => void;
}

function failWithGenericError(ctx: AnalyticsSseHandlerContext): void {
  ctx.setLoading(false);
  ctx.setError(GENERIC_LOAD_ERROR);
  ctx.unpublishWarehouseStatus();
}

/**
 * Apply the state transitions shared by analytics-query and metric-view SSE
 * messages while delegating their distinct result/status state to callbacks.
 */
export async function handleAnalyticsSseMessage(
  data: string,
  ctx: AnalyticsSseHandlerContext,
): Promise<void> {
  if (ctx.signal.aborted) return;

  try {
    const message = parseAnalyticsSseMessage(data, ctx.defaultExecutionError);

    if (message.kind === "warehouse-status") {
      ctx.onWarehouseStatus(message.status);
      return;
    }

    if (message.kind === "result") {
      ctx.setLoading(false);
      ctx.onResult(message);
      ctx.unpublishWarehouseStatus();
      return;
    }

    if (message.kind === "error") {
      ctx.setLoading(false);
      ctx.setError(message.message);
      ctx.unpublishWarehouseStatus();
      if (message.errorCode !== null) {
        ctx.setErrorCode(message.errorCode);
      }
      if (message.code) {
        console.error(
          `[${ctx.source}] Code: ${String(message.code)}, Message: ${message.message}`,
        );
      }
      return;
    }

    if (message.reason === "malformed-warehouse-status") {
      console.error(
        `[${ctx.source}] Malformed warehouse_status event`,
        message.payload,
      );
    } else {
      console.error(
        `[${ctx.source}] Unrecognized SSE payload`,
        message.payload,
      );
    }
    failWithGenericError(ctx);
  } catch (error) {
    console.warn(`[${ctx.source}] Malformed message received`, error);
    ctx.setLoading(false);
    ctx.setError(GENERIC_LOAD_ERROR);
    if (ctx.unpublishOnMalformedMessage) {
      ctx.unpublishWarehouseStatus();
    }
    ctx.abort();
  }
}

/** Apply the shared terminal state for an SSE connection failure. */
export function handleAnalyticsSseError(
  error: unknown,
  ctx: AnalyticsSseHandlerContext,
): void {
  if (ctx.signal.aborted) return;

  ctx.setLoading(false);
  ctx.unpublishWarehouseStatus();

  if (error instanceof Error) {
    console.error(`[${ctx.source}] Error`, {
      ...ctx.resource,
      error: error.message,
      stack: error.stack,
    });
  }
  ctx.setError(userFacingFetchError(error));
}
