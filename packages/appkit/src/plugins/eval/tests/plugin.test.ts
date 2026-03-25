import {
  createMockRouter,
  createMockRequest,
  createMockResponse,
  setupDatabricksEnv,
} from "@tools/test-helpers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EvalPlugin, evalPlugin } from "../plugin";
import type { IEvalConfig } from "../types";

// Mock CacheManager singleton
vi.mock("../../../cache", () => ({
  CacheManager: {
    getInstanceSync: vi.fn(() => ({
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      getOrExecute: vi.fn(async (_key: unknown[], fn: () => Promise<unknown>) =>
        fn(),
      ),
      generateKey: vi.fn(
        (parts: unknown[], userKey: string) => `${userKey}:${JSON.stringify(parts)}`,
      ),
    })),
  },
}));

// Mock TelemetryManager
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
        startActiveSpan: vi.fn(
          async (_name: string, _opts: any, fn: any) => fn({ end: vi.fn() }),
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

// Mock ProtoSerializer
vi.mock("../../proto/serialization", () => ({
  ProtoSerializer: vi.fn().mockImplementation(() => ({
    serialize: vi.fn(),
    deserialize: vi.fn(),
    writeToVolume: vi.fn(),
    readFromVolume: vi.fn(),
    toJSON: vi.fn(),
    fromJSON: vi.fn(),
  })),
}));

describe("EvalPlugin", () => {
  beforeEach(() => {
    setupDatabricksEnv();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("creates plugin with correct name", () => {
    const plugin = new EvalPlugin({});
    expect(plugin.name).toBe("eval");
  });

  test("toPlugin factory produces correct PluginData", () => {
    const data = evalPlugin({});
    expect(data.name).toBe("eval");
    expect(data.plugin).toBe(EvalPlugin);
  });

  test("toPlugin works with no config", () => {
    const data = evalPlugin();
    expect(data.name).toBe("eval");
  });

  test("static manifest has expected fields", () => {
    expect(EvalPlugin.manifest.name).toBe("eval");
    expect(EvalPlugin.manifest.displayName).toBe("Eval Pipeline Plugin");
  });

  test("injectRoutes registers health and list-results endpoints", () => {
    const plugin = new EvalPlugin({});
    const { router, handlers } = createMockRouter();

    plugin.injectRoutes(router);

    expect(handlers["GET:/health"]).toBeDefined();
    expect(handlers["GET:/runs/:runId/results"]).toBeDefined();
  });

  test("health endpoint returns config info", async () => {
    const plugin = new EvalPlugin({
      appsVolume: "/Volumes/test/vol",
      mlflowExperiment: "/test/exp",
    });
    const { router, getHandler } = createMockRouter();
    plugin.injectRoutes(router);

    const handler = getHandler("GET", "/health");
    const req = createMockRequest();
    const res = createMockResponse();

    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith({
      status: "ok",
      appsVolume: "/Volumes/test/vol",
      mlflowExperiment: "/test/exp",
    });
  });

  test("getArtifactPaths returns resolver with configured volume", () => {
    const plugin = new EvalPlugin({
      appsVolume: "/Volumes/cat/schema/vol",
    });

    const paths = plugin.getArtifactPaths();
    expect(paths.appZip("42", "my_app")).toBe(
      "/Volumes/cat/schema/vol/run_42_my_app.zip",
    );
  });

  test("exports returns expected API surface", () => {
    const plugin = new EvalPlugin({});
    const api = plugin.exports();

    expect(typeof api.getArtifactPaths).toBe("function");
    expect(typeof api.writeResult).toBe("function");
    expect(typeof api.readResult).toBe("function");
    expect(typeof api.listRunResults).toBe("function");
    expect(typeof api.computeAppeval100).toBe("function");
    expect(typeof api.aggregate).toBe("function");
  });

  test("computeAppeval100 is accessible via exports", () => {
    const plugin = new EvalPlugin({});
    const api = plugin.exports();

    const score = api.computeAppeval100({
      buildSuccess: true,
      unitTestsPass: true,
      smokeTestsPass: true,
      typeSafetyPass: true,
      localRunability: 1.0,
      appsValidatePass: true,
    });
    expect(score).toBeCloseTo(1.0);
  });

  test("shutdown completes without error", async () => {
    const plugin = new EvalPlugin({});
    await expect(plugin.shutdown()).resolves.toBeUndefined();
  });
});
