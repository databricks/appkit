import {
  createMockRouter,
  createMockRequest,
  createMockResponse,
  mockServiceContext,
  setupDatabricksEnv,
} from "@tools/test-helpers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ProtoPlugin, proto } from "../plugin";
import type { IProtoConfig } from "../types";

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

describe("ProtoPlugin", () => {
  beforeEach(() => {
    setupDatabricksEnv();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("creates plugin with correct name from manifest", () => {
    const config: IProtoConfig = {};
    const plugin = new ProtoPlugin(config);
    expect(plugin.name).toBe("proto");
  });

  test("toPlugin factory produces correct PluginData", () => {
    const pluginData = proto({});
    expect(pluginData.name).toBe("proto");
    expect(pluginData.plugin).toBe(ProtoPlugin);
    expect(pluginData.config).toEqual({});
  });

  test("toPlugin factory works with no config", () => {
    const pluginData = proto();
    expect(pluginData.name).toBe("proto");
  });

  test("static manifest has expected fields", () => {
    expect(ProtoPlugin.manifest.name).toBe("proto");
    expect(ProtoPlugin.manifest.displayName).toBe("Proto/gRPC Plugin");
    expect(ProtoPlugin.manifest.resources.required).toEqual([]);
  });

  test("setup initializes in shared mode by default", async () => {
    const plugin = new ProtoPlugin({});
    await plugin.setup();
    // No standalone server started
  });

  test("injectRoutes registers health and services endpoints", () => {
    const plugin = new ProtoPlugin({});
    const { router, handlers } = createMockRouter();

    plugin.injectRoutes(router);

    expect(handlers["GET:/health"]).toBeDefined();
    expect(handlers["GET:/services"]).toBeDefined();
  });

  test("health endpoint returns status and registered services", async () => {
    const plugin = new ProtoPlugin({});
    const { router, getHandler } = createMockRouter();

    plugin.injectRoutes(router);

    const handler = getHandler("GET", "/health");
    const req = createMockRequest();
    const res = createMockResponse();

    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith({
      status: "ok",
      mode: "shared",
      services: [],
    });
  });

  test("services endpoint returns empty list initially", async () => {
    const plugin = new ProtoPlugin({});
    const { router, getHandler } = createMockRouter();

    plugin.injectRoutes(router);

    const handler = getHandler("GET", "/services");
    const req = createMockRequest();
    const res = createMockResponse();

    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith({ services: [] });
  });

  test("exports returns expected API surface", () => {
    const plugin = new ProtoPlugin({});
    const api = plugin.exports();

    expect(typeof api.registerService).toBe("function");
    expect(typeof api.createClient).toBe("function");
    expect(typeof api.serialize).toBe("function");
    expect(typeof api.deserialize).toBe("function");
    expect(typeof api.toJSON).toBe("function");
    expect(typeof api.fromJSON).toBe("function");
    expect(typeof api.writeToVolume).toBe("function");
    expect(typeof api.readFromVolume).toBe("function");
  });

  test("shutdown completes without error", async () => {
    const plugin = new ProtoPlugin({});
    await plugin.setup();
    await expect(plugin.shutdown()).resolves.toBeUndefined();
  });
});
