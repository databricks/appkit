import {
  createMockRouter,
  createMockRequest,
  createMockResponse,
  setupDatabricksEnv,
} from "@tools/test-helpers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ProtoPlugin, proto } from "../plugin";

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

vi.mock("../../../telemetry", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    TelemetryManager: {
      getProvider: vi.fn(() => ({
        getTracer: vi.fn().mockReturnValue({
          startActiveSpan: vi.fn((...args: any[]) => {
            const fn = args[args.length - 1];
            return typeof fn === "function" ? fn({ end: vi.fn(), setAttribute: vi.fn(), setStatus: vi.fn() }) : undefined;
          }),
        }),
        getMeter: vi.fn().mockReturnValue({
          createCounter: vi.fn().mockReturnValue({ add: vi.fn() }),
          createHistogram: vi.fn().mockReturnValue({ record: vi.fn() }),
        }),
        getLogger: vi.fn().mockReturnValue({ emit: vi.fn() }),
        emit: vi.fn(),
        startActiveSpan: vi.fn(async (_n: any, _o: any, fn: any) => fn({ end: vi.fn() })),
        registerInstrumentations: vi.fn(),
      })),
    },
    normalizeTelemetryOptions: vi.fn(() => ({ traces: false, metrics: false, logs: false })),
  };
});

describe("ProtoPlugin", () => {
  beforeEach(() => setupDatabricksEnv());
  afterEach(() => vi.restoreAllMocks());

  test("creates with correct name from manifest", () => {
    expect(new ProtoPlugin({}).name).toBe("proto");
  });

  test("toPlugin factory produces correct PluginData", () => {
    const data = proto({});
    expect(data.name).toBe("proto");
    expect(data.plugin).toBe(ProtoPlugin);
  });

  test("toPlugin works with no config", () => {
    expect(proto().name).toBe("proto");
  });

  test("manifest has no required resources", () => {
    expect(ProtoPlugin.manifest.resources.required).toEqual([]);
  });

  test("injectRoutes registers health endpoint", () => {
    const plugin = new ProtoPlugin({});
    const { router, getHandler } = createMockRouter();
    plugin.injectRoutes(router);
    expect(getHandler("GET", "/health")).toBeDefined();
  });

  test("health endpoint returns ok", async () => {
    const plugin = new ProtoPlugin({});
    const { router, getHandler } = createMockRouter();
    plugin.injectRoutes(router);

    const res = createMockResponse();
    await getHandler("GET", "/health")(createMockRequest(), res);

    expect(res.json).toHaveBeenCalledWith({ status: "ok" });
  });

  test("exports returns serialization API only", () => {
    const api = new ProtoPlugin({}).exports();
    expect(typeof api.create).toBe("function");
    expect(typeof api.serialize).toBe("function");
    expect(typeof api.deserialize).toBe("function");
    expect(typeof api.toJSON).toBe("function");
    expect(typeof api.fromJSON).toBe("function");
    // No file I/O — that belongs in the Files plugin
    expect((api as any).writeToVolume).toBeUndefined();
    expect((api as any).readFromVolume).toBeUndefined();
    expect((api as any).exists).toBeUndefined();
  });
});
