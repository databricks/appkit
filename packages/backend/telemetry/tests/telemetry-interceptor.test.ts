import type { TelemetryConfig } from "@databricks-apps/types";
import { SpanStatusCode } from "@opentelemetry/api";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { TelemetryInterceptor } from "../../plugin/src/interceptors/telemetry";
import type { ExecutionContext } from "../../plugin/src/interceptors/types";
import type { ITelemetry, Span } from "../src/types";

describe("TelemetryInterceptor", () => {
  let mockTelemetry: ITelemetry;
  let mockSpan: Span;
  let context: ExecutionContext;

  beforeEach(() => {
    mockSpan = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      addEvent: vi.fn(),
      recordException: vi.fn(),
      end: vi.fn(),
    } as any;

    mockTelemetry = {
      getTracer: vi.fn(),
      getMeter: vi.fn(),
      getLogger: vi.fn(),
      emit: vi.fn(),
      startActiveSpan: vi
        .fn()
        .mockImplementation(async (_name, _options, fn) => {
          return fn(mockSpan);
        }),
      registerInstrumentations: vi.fn(),
    } as any;

    context = {
      metadata: new Map(),
    };
  });

  test("should execute function and set span status to OK on success", async () => {
    const interceptor = new TelemetryInterceptor(mockTelemetry);
    const fn = vi.fn().mockResolvedValue("success");

    const result = await interceptor.intercept(fn, context);

    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(mockSpan.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.OK,
    });
    expect(mockSpan.end).toHaveBeenCalledTimes(1);
  });

  test("should record exception and set span status to ERROR on failure", async () => {
    const interceptor = new TelemetryInterceptor(mockTelemetry);
    const error = new Error("test error");
    const fn = vi.fn().mockRejectedValue(error);

    await expect(interceptor.intercept(fn, context)).rejects.toThrow(
      "test error",
    );

    expect(mockSpan.recordException).toHaveBeenCalledWith(error);
    expect(mockSpan.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
    });
    expect(mockSpan.end).toHaveBeenCalledTimes(1);
  });

  test("should use custom span name from config", async () => {
    const config: TelemetryConfig = {
      spanName: "custom.span.name",
    };
    const interceptor = new TelemetryInterceptor(mockTelemetry, config);
    const fn = vi.fn().mockResolvedValue("result");

    await interceptor.intercept(fn, context);

    expect(mockTelemetry.startActiveSpan).toHaveBeenCalledWith(
      "custom.span.name",
      expect.any(Object),
      expect.any(Function),
    );
  });

  test("should use default span name when not provided", async () => {
    const interceptor = new TelemetryInterceptor(mockTelemetry);
    const fn = vi.fn().mockResolvedValue("result");

    await interceptor.intercept(fn, context);

    expect(mockTelemetry.startActiveSpan).toHaveBeenCalledWith(
      "plugin.execute",
      expect.any(Object),
      expect.any(Function),
    );
  });

  test("should merge custom attributes from config", async () => {
    const config: TelemetryConfig = {
      attributes: {
        "custom.attr1": "value1",
        "custom.attr2": "value2",
      },
    };
    const interceptor = new TelemetryInterceptor(mockTelemetry, config);
    const fn = vi.fn().mockResolvedValue("result");

    await interceptor.intercept(fn, context);

    expect(mockTelemetry.startActiveSpan).toHaveBeenCalledWith(
      "plugin.execute",
      {
        attributes: {
          "custom.attr1": "value1",
          "custom.attr2": "value2",
        },
      },
      expect.any(Function),
    );
  });

  test("should call span.end() in finally block even on error", async () => {
    const interceptor = new TelemetryInterceptor(mockTelemetry);
    const error = new Error("test error");
    const fn = vi.fn().mockRejectedValue(error);

    await expect(interceptor.intercept(fn, context)).rejects.toThrow();

    // Verify end was called despite the error
    expect(mockSpan.end).toHaveBeenCalledTimes(1);
  });
});
