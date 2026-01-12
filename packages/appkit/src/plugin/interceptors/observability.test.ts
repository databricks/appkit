import { describe, expect, test, vi } from "vitest";
import { ObservabilityInterceptor } from "./observability";

describe("ObservabilityInterceptor", () => {
  test("should pass only operation to logger.span (default: execute)", async () => {
    const logger = {
      span: vi.fn(async (_name: string, fn: any) => await fn()),
    } as any;

    const interceptor = new ObservabilityInterceptor(logger);

    await interceptor.intercept(async () => "ok", {
      pluginName: "analytics",
      userKey: "u1",
    });

    expect(logger.span).toHaveBeenCalledWith("execute", expect.any(Function));
  });

  test("should pass operation to logger.span when provided", async () => {
    const logger = {
      span: vi.fn(async (_name: string, fn: any) => await fn()),
    } as any;

    const interceptor = new ObservabilityInterceptor(logger);

    await interceptor.intercept(async () => "ok", {
      pluginName: "analytics",
      operation: "query",
      userKey: "u1",
    });

    expect(logger.span).toHaveBeenCalledWith("query", expect.any(Function));
  });

  test("should strip redundant plugin prefix from operation", async () => {
    const logger = {
      span: vi.fn(async (_name: string, fn: any) => await fn()),
    } as any;

    const interceptor = new ObservabilityInterceptor(logger);

    await interceptor.intercept(async () => "ok", {
      pluginName: "analytics",
      operation: "analytics.query",
      userKey: "u1",
    });

    expect(logger.span).toHaveBeenCalledWith("query", expect.any(Function));
  });
});
