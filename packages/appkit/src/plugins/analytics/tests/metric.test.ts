import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createMockRequest,
  createMockResponse,
  createMockRouter,
  mockServiceContext,
  setupDatabricksEnv,
} from "@tools/test-helpers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ServiceContext } from "../../../context/service-context";
import { AnalyticsPlugin } from "../analytics";
import { buildMetricSql, loadMetricRegistry } from "../metric";
import type { IAnalyticsConfig, MetricRegistration } from "../types";

// Mirror the analytics.test.ts CacheManager mock so the inner `execute`'s
// cache interceptor is a no-op pass-through (each request re-executes).
const { mockCacheStore, mockCacheInstance } = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  const generateKey = (parts: unknown[], userKey: string): string => {
    const { createHash } = require("node:crypto");
    const serialized = JSON.stringify([userKey, ...parts]);
    return createHash("sha256").update(serialized).digest("hex");
  };
  const instance = {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    getOrExecute: vi.fn(
      async (key: unknown[], fn: () => Promise<unknown>, userKey: string) => {
        const cacheKey = generateKey(key, userKey);
        if (store.has(cacheKey)) return store.get(cacheKey);
        const result = await fn();
        store.set(cacheKey, result);
        return result;
      },
    ),
    generateKey: vi.fn((parts: unknown[], userKey: string) =>
      generateKey(parts, userKey),
    ),
  };
  return { mockCacheStore: store, mockCacheInstance: instance };
});

vi.mock("../../../cache", () => ({
  CacheManager: {
    getInstanceSync: vi.fn(() => mockCacheInstance),
  },
}));

/** Feed the plugin a registry directly, bypassing the disk config parse. */
function setRegistry(
  plugin: AnalyticsPlugin,
  registry: Record<string, MetricRegistration>,
): void {
  (plugin as any).metricRegistry = registry;
  (plugin as any).metricRegistryLoadError = null;
}

describe("analytics metric route (Phase 1)", () => {
  let config: IAnalyticsConfig;
  let serviceContextMock: Awaited<ReturnType<typeof mockServiceContext>>;

  beforeEach(async () => {
    config = { timeout: 5000 };
    setupDatabricksEnv();
    mockCacheStore.clear();
    ServiceContext.reset();
    serviceContextMock = await mockServiceContext();
  });

  afterEach(() => {
    serviceContextMock?.restore();
  });

  describe("injectRoutes", () => {
    test("registers POST /metric/:key alongside /query", () => {
      const plugin = new AnalyticsPlugin(config);
      const { router } = createMockRouter();

      plugin.injectRoutes(router);

      expect(router.post).toHaveBeenCalledWith(
        "/metric/:key",
        expect.any(Function),
      );
    });
  });

  // ── Grammar gate — the primary security test (replaces #341's
  // fail-closed-503 allowlist test). A measure that fails MEASURE_NAME_PATTERN
  // throws inside buildMetricSql BEFORE any SQL string is constructed.
  describe("buildMetricSql grammar gate", () => {
    const registration: MetricRegistration = {
      key: "revenue",
      source: "cat.sch.revenue_metrics",
      lane: "sp",
    };

    test("throws before building SQL for an injection-shaped measure", () => {
      expect(() =>
        buildMetricSql(registration, {
          measures: ["arr; DROP TABLE users"],
        }),
      ).toThrow(/not a valid identifier/);
    });

    test("throws for a measure with a backtick / quote", () => {
      expect(() =>
        buildMetricSql(registration, { measures: ["arr`"] }),
      ).toThrow(/not a valid identifier/);
    });

    test("throws when no measures are supplied", () => {
      expect(() => buildMetricSql(registration, { measures: [] })).toThrow(
        /at least one measure/,
      );
    });

    test("throws for a non-three-part source FQN", () => {
      expect(() =>
        buildMetricSql(
          { key: "x", source: "cat.sch", lane: "sp" },
          { measures: ["arr"] },
        ),
      ).toThrow(/not a valid three-part UC FQN/);
    });
  });

  // ── Measures-only SQL shape.
  describe("buildMetricSql SQL shape", () => {
    const registration: MetricRegistration = {
      key: "revenue",
      source: "cat.sch.revenue_metrics",
      lane: "sp",
    };

    test("single measure → SELECT MEASURE(m) AS m FROM <fqn>", () => {
      const { statement, parameters } = buildMetricSql(registration, {
        measures: ["arr"],
      });
      expect(statement).toBe(
        "SELECT MEASURE(arr) AS arr FROM cat.sch.revenue_metrics",
      );
      expect(parameters).toEqual({});
    });

    test("multiple measures are sorted for a deterministic SELECT list", () => {
      const { statement } = buildMetricSql(registration, {
        measures: ["revenue", "arr"],
      });
      expect(statement).toBe(
        "SELECT MEASURE(arr) AS arr, MEASURE(revenue) AS revenue FROM cat.sch.revenue_metrics",
      );
    });

    test("positive limit appends a floored LIMIT clause", () => {
      const { statement } = buildMetricSql(registration, {
        measures: ["arr"],
        limit: 10.9,
      });
      expect(statement).toBe(
        "SELECT MEASURE(arr) AS arr FROM cat.sch.revenue_metrics LIMIT 10",
      );
    });
  });

  // ── Envelope parity — streams warehouse_status* then a `result` message,
  // byte-identical to the /query route's JSON SSE path.
  describe("_handleMetricRoute SSE envelope", () => {
    test("streams warehouse_status then a result message with aliased rows", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();
      setRegistry(plugin, {
        revenue: {
          key: "revenue",
          source: "cat.sch.revenue_metrics",
          lane: "sp",
        },
      });

      const executeMock = vi.fn().mockResolvedValue({
        result: { data: [{ arr: 1234 }] },
      });
      (plugin as any).SQLClient.executeStatement = executeMock;

      plugin.injectRoutes(router);
      const handler = getHandler("POST", "/metric/:key");
      const mockReq = createMockRequest({
        params: { key: "revenue" },
        body: { measures: ["arr"] },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      // The measures-only SQL reaches the warehouse.
      expect(executeMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          statement: "SELECT MEASURE(arr) AS arr FROM cat.sch.revenue_metrics",
          warehouse_id: "test-warehouse-id",
        }),
        expect.any(AbortSignal),
      );

      // Same SSE envelope as /query: a `result` event carrying the rows.
      expect(mockRes.write).toHaveBeenCalledWith("event: result\n");
      expect(mockRes.write).toHaveBeenCalledWith(
        expect.stringContaining('"data":[{"arr":1234}]'),
      );
      expect(mockRes.end).toHaveBeenCalled();
    });

    test("emits warehouse_status before result for a STARTING warehouse", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();
      setRegistry(plugin, {
        revenue: {
          key: "revenue",
          source: "cat.sch.revenue_metrics",
          lane: "sp",
        },
      });

      const executeMock = vi.fn().mockResolvedValue({
        result: { data: [{ arr: 1 }] },
      });
      (plugin as any).SQLClient.executeStatement = executeMock;

      plugin.injectRoutes(router);
      const handler = getHandler("POST", "/metric/:key");

      const warehouseGet = vi
        .fn()
        .mockResolvedValueOnce({ state: "STARTING" })
        .mockResolvedValueOnce({ state: "RUNNING" });
      const mockReq = createMockRequest({
        params: { key: "revenue" },
        body: { measures: ["arr"] },
      });
      mockReq.serviceWorkspaceClient.warehouses.get = warehouseGet;
      mockReq.userWorkspaceClient.warehouses.get = warehouseGet;
      const mockRes = createMockResponse();

      vi.useFakeTimers();
      const handlerPromise = handler(mockReq, mockRes);
      await vi.runAllTimersAsync();
      await handlerPromise;
      vi.useRealTimers();

      const eventLines = (mockRes.write as any).mock.calls
        .map((call: any[]) => call[0] as string)
        .filter((s: string) => s.startsWith("event: "));
      const warehouseIdx = eventLines.findIndex(
        (s: string) => s === "event: warehouse_status\n",
      );
      const resultIdx = eventLines.findIndex(
        (s: string) => s === "event: result\n",
      );
      expect(warehouseIdx).toBeGreaterThanOrEqual(0);
      expect(resultIdx).toBeGreaterThanOrEqual(0);
      expect(warehouseIdx).toBeLessThan(resultIdx);
    });

    test("returns 400 when the body fails structural validation", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();
      setRegistry(plugin, {
        revenue: {
          key: "revenue",
          source: "cat.sch.revenue_metrics",
          lane: "sp",
        },
      });

      plugin.injectRoutes(router);
      const handler = getHandler("POST", "/metric/:key");
      const mockReq = createMockRequest({
        params: { key: "revenue" },
        body: { measures: [] }, // empty → fails .min(1)
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
    });
  });

  // ── 503-vs-404 latching + dormancy.
  describe("registry latching and dormancy", () => {
    test("unknown key against a valid registry → 404 (generic body)", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();
      setRegistry(plugin, {
        revenue: {
          key: "revenue",
          source: "cat.sch.revenue_metrics",
          lane: "sp",
        },
      });

      plugin.injectRoutes(router);
      const handler = getHandler("POST", "/metric/:key");
      const mockReq = createMockRequest({
        params: { key: "nope" },
        body: { measures: ["arr"] },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(404);
      expect(mockRes.json).toHaveBeenCalledWith({ error: "Metric not found" });
    });

    test("malformed registry → 503 METRIC_REGISTRY_LOAD_FAILED", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();
      // Latch a load error directly (as a malformed config would).
      (plugin as any).metricRegistry = {};
      (plugin as any).metricRegistryLoadError = "Invalid metric-views.json";

      plugin.injectRoutes(router);
      const handler = getHandler("POST", "/metric/:key");
      const mockReq = createMockRequest({
        params: { key: "revenue" },
        body: { measures: ["arr"] },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(503);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: "Metric registry not available",
        code: "METRIC_REGISTRY_LOAD_FAILED",
      });
    });

    test("no metric-views.json present → registry empty, unknown key 404, nothing executes", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      const executeMock = vi.fn();
      (plugin as any).SQLClient.executeStatement = executeMock;
      // Registry lazily loads from cwd; no config/queries/metric-views.json in
      // the test cwd → empty registry (dormant).
      plugin.injectRoutes(router);
      const handler = getHandler("POST", "/metric/:key");
      const mockReq = createMockRequest({
        params: { key: "revenue" },
        body: { measures: ["arr"] },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(404);
      expect(executeMock).not.toHaveBeenCalled();
    });
  });
});

// ── loadMetricRegistry: config parse against the landed metricSourceSchema.
describe("loadMetricRegistry", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "mv-registry-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("absent metric-views.json → empty registry (dormancy)", () => {
    expect(loadMetricRegistry(dir)).toEqual({});
  });

  test("derives lane from executor (default sp, user → obo)", () => {
    writeFileSync(
      path.join(dir, "metric-views.json"),
      JSON.stringify({
        metricViews: {
          revenue: { source: "cat.sch.revenue_metrics" },
          customers: { source: "cat.sch.customer_metrics", executor: "user" },
        },
      }),
    );

    const registry = loadMetricRegistry(dir);
    expect(registry.revenue).toEqual({
      key: "revenue",
      source: "cat.sch.revenue_metrics",
      lane: "sp",
    });
    expect(registry.customers).toEqual({
      key: "customers",
      source: "cat.sch.customer_metrics",
      lane: "obo",
    });
  });

  test("malformed JSON throws", () => {
    writeFileSync(path.join(dir, "metric-views.json"), "{ not json");
    expect(() => loadMetricRegistry(dir)).toThrow(/Failed to parse/);
  });

  test("schema-invalid config throws", () => {
    writeFileSync(
      path.join(dir, "metric-views.json"),
      JSON.stringify({
        metricViews: { revenue: { source: "not-a-three-part-fqn" } },
      }),
    );
    expect(() => loadMetricRegistry(dir)).toThrow(/Invalid metric-views.json/);
  });
});
