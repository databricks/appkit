import { createMockRouter, setupDatabricksEnv } from "@tools/test-helpers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { JobsPlugin, jobs } from "../plugin";

vi.mock("../../../cache", () => ({
  CacheManager: {
    getInstanceSync: vi.fn(() => ({
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      getOrExecute: vi.fn(async (_k: any, fn: any) => fn()),
      generateKey: vi.fn((p: any, u: any) => `${u}:${JSON.stringify(p)}`),
    })),
  },
}));

vi.mock("@databricks/sdk-experimental", () => ({
  WorkspaceClient: vi.fn(),
}));

vi.mock("../../../context", () => ({
  getWorkspaceClient: vi.fn(() => ({})),
}));

vi.mock("../../../connectors/jobs", () => ({
  JobsConnector: vi.fn(() => ({
    submitRun: vi.fn(),
    runNow: vi.fn(),
    getRun: vi.fn(),
    getRunOutput: vi.fn(),
    cancelRun: vi.fn(),
    listRuns: vi.fn(),
    getJob: vi.fn(),
    createJob: vi.fn(),
    waitForRun: vi.fn(),
  })),
}));

vi.mock("../../../logging/logger", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock("../../../telemetry", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    TelemetryManager: {
      getProvider: vi.fn(() => ({
        getTracer: vi.fn().mockReturnValue({
          startActiveSpan: vi.fn((...args: any[]) => {
            const fn = args[args.length - 1];
            return typeof fn === "function"
              ? fn({ end: vi.fn(), setAttribute: vi.fn(), setStatus: vi.fn() })
              : undefined;
          }),
        }),
        getMeter: vi.fn().mockReturnValue({
          createCounter: vi.fn().mockReturnValue({ add: vi.fn() }),
          createHistogram: vi.fn().mockReturnValue({ record: vi.fn() }),
        }),
        getLogger: vi.fn().mockReturnValue({ emit: vi.fn() }),
        emit: vi.fn(),
        startActiveSpan: vi.fn(async (_n: any, _o: any, fn: any) =>
          fn({ end: vi.fn() }),
        ),
        registerInstrumentations: vi.fn(),
      })),
    },
    normalizeTelemetryOptions: vi.fn(() => ({
      traces: false,
      metrics: false,
      logs: false,
    })),
  };
});

describe("JobsPlugin", () => {
  beforeEach(() => setupDatabricksEnv());
  afterEach(() => vi.restoreAllMocks());

  test("creates with correct name from manifest", () => {
    expect(new JobsPlugin({}).name).toBe("jobs");
  });

  test("toPlugin factory produces correct PluginData", () => {
    const data = jobs({});
    expect(data.name).toBe("jobs");
    expect(data.plugin).toBe(JobsPlugin);
  });

  test("toPlugin works with no config", () => {
    expect(jobs().name).toBe("jobs");
  });

  test("manifest has no required resources", () => {
    expect(JobsPlugin.manifest.resources.required).toEqual([]);
  });

  test("does not register health endpoint (no routes)", () => {
    const plugin = new JobsPlugin({});
    const { router, getHandler } = createMockRouter();
    plugin.injectRoutes(router);
    expect(getHandler("GET", "/health")).toBeUndefined();
  });

  test("exports returns all 9 Jobs API methods", () => {
    const api = new JobsPlugin({}).exports();
    expect(typeof api.submitRun).toBe("function");
    expect(typeof api.runNow).toBe("function");
    expect(typeof api.getRun).toBe("function");
    expect(typeof api.getRunOutput).toBe("function");
    expect(typeof api.cancelRun).toBe("function");
    expect(typeof api.listRuns).toBe("function");
    expect(typeof api.getJob).toBe("function");
    expect(typeof api.createJob).toBe("function");
    expect(typeof api.waitForRun).toBe("function");
  });

  test("exports does not include internal methods", () => {
    const api = new JobsPlugin({}).exports();
    expect((api as any).setup).toBeUndefined();
    expect((api as any).shutdown).toBeUndefined();
    expect((api as any).injectRoutes).toBeUndefined();
    expect((api as any).connector).toBeUndefined();
  });
});
