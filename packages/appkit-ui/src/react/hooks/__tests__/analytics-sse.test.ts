import { describe, expect, test, vi } from "vitest";

import {
  type AnalyticsSseHandlerContext,
  GENERIC_LOAD_ERROR,
  handleAnalyticsSseError,
  handleAnalyticsSseMessage,
  parseAnalyticsSseMessage,
  userFacingFetchError,
} from "../analytics-sse";

function createContext(overrides: Partial<AnalyticsSseHandlerContext> = {}) {
  const controller = new AbortController();
  const abort = vi.fn(() => controller.abort());
  const context: AnalyticsSseHandlerContext = {
    source: "useAnalyticsQuery",
    resource: { queryKey: "orders" },
    defaultExecutionError: "Unable to execute query",
    unpublishOnMalformedMessage: false,
    signal: controller.signal,
    abort,
    setLoading: vi.fn(),
    setError: vi.fn(),
    setErrorCode: vi.fn(),
    onWarehouseStatus: vi.fn(),
    onResult: vi.fn(),
    unpublishWarehouseStatus: vi.fn(),
    ...overrides,
  };
  return { abort, context, controller };
}

describe("analytics SSE parsing", () => {
  test("classifies warehouse status, normalized results, and structured errors", () => {
    expect(
      parseAnalyticsSseMessage(
        JSON.stringify({
          type: "warehouse_status",
          status: { state: "STARTING", elapsedMs: 1200 },
        }),
        "fallback",
      ),
    ).toEqual({
      kind: "warehouse-status",
      status: { state: "STARTING", elapsedMs: 1200 },
    });

    expect(
      parseAnalyticsSseMessage(
        JSON.stringify({ type: "result", metadata: { amount: {} } }),
        "fallback",
      ),
    ).toEqual({
      kind: "result",
      data: [],
      payload: { type: "result", metadata: { amount: {} } },
    });

    expect(
      parseAnalyticsSseMessage(
        JSON.stringify({
          type: "error",
          message: "Query failed",
          code: "UPSTREAM_ERROR",
          errorCode: "STATEMENT_FAILED",
        }),
        "fallback",
      ),
    ).toEqual({
      kind: "error",
      message: "Query failed",
      code: "UPSTREAM_ERROR",
      errorCode: "STATEMENT_FAILED",
    });
  });

  test("classifies malformed warehouse status and unknown payloads as invalid", () => {
    expect(
      parseAnalyticsSseMessage(
        JSON.stringify({ type: "warehouse_status" }),
        "fallback",
      ),
    ).toMatchObject({
      kind: "invalid",
      reason: "malformed-warehouse-status",
    });

    expect(
      parseAnalyticsSseMessage(
        JSON.stringify({ type: "heartbeat" }),
        "fallback",
      ),
    ).toMatchObject({ kind: "invalid", reason: "unrecognized" });
  });
});

describe("analytics SSE handling", () => {
  test("applies common success state and delegates result-specific fields", async () => {
    const { context } = createContext();

    await handleAnalyticsSseMessage(
      JSON.stringify({
        type: "result",
        data: [{ amount: 42 }],
        metadata: { amount: { type: "LONG" } },
      }),
      context,
    );

    expect(context.setLoading).toHaveBeenCalledWith(false);
    expect(context.onResult).toHaveBeenCalledWith({
      kind: "result",
      data: [{ amount: 42 }],
      payload: {
        type: "result",
        data: [{ amount: 42 }],
        metadata: { amount: { type: "LONG" } },
      },
    });
    expect(context.unpublishWarehouseStatus).toHaveBeenCalledOnce();
    expect(context.setError).not.toHaveBeenCalled();
  });

  test("surfaces server errors and their structured code", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { abort, context } = createContext();

    await handleAnalyticsSseMessage(
      JSON.stringify({
        type: "error",
        error: "Server is at capacity",
        code: "UPSTREAM_ERROR",
        errorCode: "WAREHOUSE_CAPACITY",
      }),
      context,
    );

    expect(context.setLoading).toHaveBeenCalledWith(false);
    expect(context.setError).toHaveBeenCalledWith("Server is at capacity");
    expect(context.setErrorCode).toHaveBeenCalledWith("WAREHOUSE_CAPACITY");
    expect(context.unpublishWarehouseStatus).toHaveBeenCalledOnce();
    expect(abort).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      "[useAnalyticsQuery] Code: UPSTREAM_ERROR, Message: Server is at capacity",
    );
    errorSpy.mockRestore();
  });

  test("terminates malformed streams with the generic user-facing error", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { abort, context, controller } = createContext();

    await handleAnalyticsSseMessage("not-json{", context);

    expect(context.setLoading).toHaveBeenCalledWith(false);
    expect(context.setError).toHaveBeenCalledWith(GENERIC_LOAD_ERROR);
    expect(context.unpublishWarehouseStatus).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledOnce();
    expect(controller.signal.aborted).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      "[useAnalyticsQuery] Malformed message received",
      expect.any(SyntaxError),
    );
    warnSpy.mockRestore();
  });

  test("retains metric-view warehouse cleanup for malformed streams", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { context } = createContext({
      source: "useMetricView",
      unpublishOnMalformedMessage: true,
    });

    await handleAnalyticsSseMessage("not-json{", context);

    expect(context.unpublishWarehouseStatus).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  test("maps transport failures and ignores errors after abort", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { context, controller } = createContext();

    handleAnalyticsSseError(new Error("Failed to fetch"), context);

    expect(context.setLoading).toHaveBeenCalledWith(false);
    expect(context.setError).toHaveBeenCalledWith(
      "Network error. Please check your connection.",
    );
    expect(context.unpublishWarehouseStatus).toHaveBeenCalledOnce();

    vi.mocked(context.setError).mockClear();
    controller.abort();
    handleAnalyticsSseError(new Error("late failure"), context);
    expect(context.setError).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});

test("maps timeout and unknown failures to the existing user-facing messages", () => {
  const timeout = new Error("aborted");
  timeout.name = "AbortError";

  expect(userFacingFetchError(timeout)).toBe(
    "Request timed out, please try again",
  );
  expect(userFacingFetchError(new Error("other"))).toBe(GENERIC_LOAD_ERROR);
});
