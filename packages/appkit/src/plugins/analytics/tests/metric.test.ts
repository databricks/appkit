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
import { AuthenticationError } from "../../../errors";
import { AnalyticsPlugin } from "../analytics";
import {
  buildMetricSql,
  composeMetricCacheKey,
  deriveMetricExecutorKey,
  loadMetricRegistry,
  validateMetricRequest,
} from "../metric";
import type {
  IAnalyticsConfig,
  MetricFilter,
  MetricRegistration,
} from "../types";

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

  // ── Phase 2: dimensions + GROUP BY ALL. Bare dimensions here; date_trunc
  // grain application (via timeDimension) is covered in its own block below.
  describe("buildMetricSql dimensions + GROUP BY", () => {
    const registration: MetricRegistration = {
      key: "revenue",
      source: "cat.sch.revenue_metrics",
      lane: "sp",
    };

    test("measures + dimensions → SELECT MEASURE(...), <dim> FROM <fqn> GROUP BY ALL", () => {
      const { statement } = buildMetricSql(registration, {
        measures: ["arr"],
        dimensions: ["region"],
      });
      expect(statement).toBe(
        "SELECT MEASURE(arr) AS arr, region FROM cat.sch.revenue_metrics GROUP BY ALL",
      );
    });

    test("dimensions are sorted for a deterministic SELECT list", () => {
      const { statement } = buildMetricSql(registration, {
        measures: ["arr"],
        dimensions: ["segment", "region"],
      });
      expect(statement).toBe(
        "SELECT MEASURE(arr) AS arr, region, segment FROM cat.sch.revenue_metrics GROUP BY ALL",
      );
    });

    test("measures sort before dimensions in the SELECT list", () => {
      const { statement } = buildMetricSql(registration, {
        measures: ["revenue", "arr"],
        dimensions: ["region"],
      });
      expect(statement).toBe(
        "SELECT MEASURE(arr) AS arr, MEASURE(revenue) AS revenue, region FROM cat.sch.revenue_metrics GROUP BY ALL",
      );
    });

    test("empty dimensions array → no GROUP BY (ungrouped)", () => {
      const { statement } = buildMetricSql(registration, {
        measures: ["arr"],
        dimensions: [],
      });
      expect(statement).toBe(
        "SELECT MEASURE(arr) AS arr FROM cat.sch.revenue_metrics",
      );
    });

    test("dimensions + limit compose GROUP BY ALL then LIMIT", () => {
      const { statement } = buildMetricSql(registration, {
        measures: ["arr"],
        dimensions: ["region"],
        limit: 100,
      });
      expect(statement).toBe(
        "SELECT MEASURE(arr) AS arr, region FROM cat.sch.revenue_metrics GROUP BY ALL LIMIT 100",
      );
    });

    test("no timeGrain → all dimensions render bare (no date_trunc)", () => {
      const { statement } = buildMetricSql(registration, {
        measures: ["arr"],
        dimensions: ["order_date", "region"],
      });
      expect(statement).toBe(
        "SELECT MEASURE(arr) AS arr, order_date, region FROM cat.sch.revenue_metrics GROUP BY ALL",
      );
      expect(statement).not.toContain("date_trunc");
    });
  });

  // ── Phase 2a: timeGrain + timeDimension → date_trunc on the named column.
  // The grain is a grammar-gated single-quoted literal; the column keeps its
  // plain alias; other dimensions render bare; GROUP BY ALL is present.
  describe("buildMetricSql timeGrain + timeDimension (date_trunc)", () => {
    const registration: MetricRegistration = {
      key: "revenue",
      source: "cat.sch.revenue_metrics",
      lane: "sp",
    };

    test("buckets only the timeDimension via date_trunc; other dimensions bare", () => {
      const { statement } = buildMetricSql(registration, {
        measures: ["arr"],
        dimensions: ["order_date", "region"],
        timeGrain: "month",
        timeDimension: "order_date",
      });
      expect(statement).toBe(
        "SELECT MEASURE(arr) AS arr, date_trunc('month', order_date) AS order_date, region FROM cat.sch.revenue_metrics GROUP BY ALL",
      );
      expect(statement).toContain(
        "date_trunc('month', order_date) AS order_date",
      );
      expect(statement).toContain(" GROUP BY ALL");
    });

    test("the grain literal is threaded through (day) for the timeDimension", () => {
      const { statement } = buildMetricSql(registration, {
        measures: ["arr"],
        dimensions: ["order_date"],
        timeGrain: "day",
        timeDimension: "order_date",
      });
      expect(statement).toBe(
        "SELECT MEASURE(arr) AS arr, date_trunc('day', order_date) AS order_date FROM cat.sch.revenue_metrics GROUP BY ALL",
      );
    });
  });

  // ── Phase 2: dimension grammar gate. A dimension failing
  // DIMENSION_NAME_PATTERN throws inside buildMetricSql before SQL is built.
  describe("buildMetricSql dimension grammar gate", () => {
    const registration: MetricRegistration = {
      key: "revenue",
      source: "cat.sch.revenue_metrics",
      lane: "sp",
    };

    test("throws before building SQL for an injection-shaped dimension", () => {
      expect(() =>
        buildMetricSql(registration, {
          measures: ["arr"],
          dimensions: ["region; DROP TABLE users"],
        }),
      ).toThrow(/not a valid identifier/);
    });

    test("throws for a dimension with a backtick / quote", () => {
      expect(() =>
        buildMetricSql(registration, {
          measures: ["arr"],
          dimensions: ["region`"],
        }),
      ).toThrow(/not a valid identifier/);
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

// ── Phase 2: the structured filter engine (translator + validator).
// Registry-free: names are grammar-gated, values are parameterized. No
// allowlist, no op⇄dimension-type check.
describe("metric — filter translator", () => {
  const registration: MetricRegistration = {
    key: "revenue",
    source: "cat.sch.revenue_metrics",
    lane: "sp",
  };

  // Render a filter via buildMetricSql and return the WHERE fragment + params.
  function render(filter: unknown) {
    const { statement, parameters } = buildMetricSql(registration, {
      measures: ["arr"],
      filter: filter as never,
    });
    const match = statement.match(/ WHERE (.+?)( GROUP BY| LIMIT|$)/);
    const where = match ? match[1] : null;
    return { statement, where, parameters };
  }

  describe("operators (12 unit tests)", () => {
    test("equals → `<col> = :f_0`", () => {
      const { where, parameters } = render({
        member: "region",
        operator: "equals",
        values: ["EMEA"],
      });
      expect(where).toBe("region = :f_0");
      expect(parameters).toEqual({
        f_0: { __sql_type: "STRING", value: "EMEA" },
      });
    });

    test("notEquals → `<col> <> :f_0`", () => {
      const { where, parameters } = render({
        member: "region",
        operator: "notEquals",
        values: ["EMEA"],
      });
      expect(where).toBe("region <> :f_0");
      expect(parameters.f_0).toEqual({ __sql_type: "STRING", value: "EMEA" });
    });

    test("in → `<col> IN (:f_0, :f_1, ...)`", () => {
      const { where, parameters } = render({
        member: "region",
        operator: "in",
        values: ["EMEA", "APAC", "AMER"],
      });
      expect(where).toBe("region IN (:f_0, :f_1, :f_2)");
      expect(parameters.f_0).toEqual({ __sql_type: "STRING", value: "EMEA" });
      expect(parameters.f_1).toEqual({ __sql_type: "STRING", value: "APAC" });
      expect(parameters.f_2).toEqual({ __sql_type: "STRING", value: "AMER" });
    });

    test("notIn → `<col> NOT IN (:f_0, :f_1, ...)`", () => {
      const { where, parameters } = render({
        member: "region",
        operator: "notIn",
        values: ["EMEA", "APAC"],
      });
      expect(where).toBe("region NOT IN (:f_0, :f_1)");
      expect(Object.keys(parameters)).toHaveLength(2);
    });

    test("gt → `<col> > :f_0` (numeric value bound as INT)", () => {
      const { where, parameters } = render({
        member: "deal_size",
        operator: "gt",
        values: [10000],
      });
      expect(where).toBe("deal_size > :f_0");
      expect(parameters.f_0).toEqual({ __sql_type: "INT", value: "10000" });
    });

    test("gte → `<col> >= :f_0`", () => {
      const { where } = render({
        member: "deal_size",
        operator: "gte",
        values: [5000],
      });
      expect(where).toBe("deal_size >= :f_0");
    });

    test("lt → `<col> < :f_0`", () => {
      const { where } = render({
        member: "deal_size",
        operator: "lt",
        values: [100],
      });
      expect(where).toBe("deal_size < :f_0");
    });

    test("lte → `<col> <= :f_0`", () => {
      const { where } = render({
        member: "deal_size",
        operator: "lte",
        values: [50000],
      });
      expect(where).toBe("deal_size <= :f_0");
    });

    test("contains → `<col> LIKE :f_0` (value wrapped in %...%)", () => {
      const { where, parameters } = render({
        member: "region",
        operator: "contains",
        values: ["MEA"],
      });
      expect(where).toBe("region LIKE :f_0");
      expect(parameters.f_0).toEqual({ __sql_type: "STRING", value: "%MEA%" });
    });

    test("notContains → `<col> NOT LIKE :f_0`", () => {
      const { where, parameters } = render({
        member: "region",
        operator: "notContains",
        values: ["test"],
      });
      expect(where).toBe("region NOT LIKE :f_0");
      expect(parameters.f_0).toEqual({
        __sql_type: "STRING",
        value: "%test%",
      });
    });

    test("set → `<col> IS NOT NULL` (no bind)", () => {
      const { where, parameters } = render({
        member: "region",
        operator: "set",
      });
      expect(where).toBe("region IS NOT NULL");
      expect(parameters).toEqual({});
    });

    test("notSet → `<col> IS NULL` (no bind)", () => {
      const { where, parameters } = render({
        member: "region",
        operator: "notSet",
      });
      expect(where).toBe("region IS NULL");
      expect(parameters).toEqual({});
    });
  });

  describe("AND/OR composition", () => {
    test("flat AND group renders predicates joined by AND", () => {
      const { where, parameters } = render({
        and: [
          { member: "region", operator: "equals", values: ["EMEA"] },
          { member: "segment", operator: "equals", values: ["Enterprise"] },
        ],
      });
      expect(where).toBe("(region = :f_0 AND segment = :f_1)");
      expect(parameters.f_0.value).toBe("EMEA");
      expect(parameters.f_1.value).toBe("Enterprise");
    });

    test("flat OR group renders predicates joined by OR", () => {
      const { where } = render({
        or: [
          { member: "region", operator: "equals", values: ["EMEA"] },
          { member: "region", operator: "equals", values: ["APAC"] },
        ],
      });
      expect(where).toBe("(region = :f_0 OR region = :f_1)");
    });

    test("AND-of-OR composes nested groups", () => {
      const { where } = render({
        and: [
          { member: "region", operator: "in", values: ["EMEA", "APAC"] },
          {
            or: [
              { member: "segment", operator: "equals", values: ["Enterprise"] },
              { member: "deal_size", operator: "gt", values: [50000] },
            ],
          },
        ],
      });
      expect(where).toContain("(region IN (");
      expect(where).toContain(" AND ");
      expect(where).toContain("OR");
    });

    test("OR-of-AND composes nested groups", () => {
      const { where } = render({
        or: [
          {
            and: [
              { member: "region", operator: "equals", values: ["EMEA"] },
              { member: "segment", operator: "equals", values: ["Enterprise"] },
            ],
          },
          { member: "region", operator: "equals", values: ["APAC"] },
        ],
      });
      expect(where).toMatch(/^\(.+ OR .+\)$/);
      expect(where).toContain(" AND ");
    });

    test("empty `and: []` group emits no WHERE clause", () => {
      const { statement, parameters } = buildMetricSql(registration, {
        measures: ["arr"],
        filter: { and: [] },
      });
      expect(statement).not.toContain("WHERE");
      expect(parameters).toEqual({});
    });

    test("empty `or: []` renders 1 = 0 (defense in depth past the validator)", () => {
      // The validator rejects `or: []` (see cardinality tests), but if a bypass
      // ever reaches the renderer, an empty disjunction must render vacuous-
      // false — never drop the predicate (which would mean "match everything").
      const { where } = render({ or: [] });
      expect(where).toBe("1 = 0");
    });
  });

  describe("depth cap", () => {
    test("rejects 9 levels of AND nesting at preCheckFilterDepth (before Zod)", () => {
      let node: unknown = {
        member: "region",
        operator: "equals",
        values: ["EMEA"],
      };
      for (let i = 0; i < 9; i += 1) {
        node = { and: [node] };
      }
      expect(() =>
        validateMetricRequest({ measures: ["arr"], filter: node }),
      ).toThrowError(/fields:.*filter/);
    });

    test("accepts exactly 8 levels of AND nesting (validator)", () => {
      let node: unknown = {
        member: "region",
        operator: "equals",
        values: ["EMEA"],
      };
      for (let i = 0; i < 8; i += 1) {
        node = { and: [node] };
      }
      expect(() =>
        validateMetricRequest({ measures: ["arr"], filter: node }),
      ).not.toThrow();
    });

    test("renderFilter independently rejects nesting past the depth cap", () => {
      // Second, independent depth enforcement: even if a payload bypasses the
      // pre-Zod pre-check and Zod's superRefine, the SQL renderer re-checks the
      // depth as defense in depth. Build 9-deep and call buildMetricSql
      // directly (skipping validateMetricRequest).
      let node: unknown = {
        member: "region",
        operator: "equals",
        values: ["EMEA"],
      };
      for (let i = 0; i < 9; i += 1) {
        node = { and: [node] };
      }
      expect(() =>
        buildMetricSql(registration, {
          measures: ["arr"],
          filter: node as never,
        }),
      ).toThrow(/nesting exceeds the maximum depth/);
    });

    test("rejects pathologically deep filter without stack-overflow (pre-parse cap)", () => {
      let node: unknown = {
        member: "region",
        operator: "equals",
        values: ["EMEA"],
      };
      for (let i = 0; i < 10_000; i += 1) {
        node = { and: [node] };
      }
      expect(() =>
        validateMetricRequest({ measures: ["arr"], filter: node }),
      ).toThrowError(/fields:.*filter/);
    });

    test("rejects deep `or` even when paired with empty `and` (else-if bypass guard)", () => {
      let deepOr: unknown = {
        member: "region",
        operator: "equals",
        values: ["EMEA"],
      };
      for (let i = 0; i < 10_000; i += 1) {
        deepOr = { or: [deepOr] };
      }
      expect(() =>
        validateMetricRequest({
          measures: ["arr"],
          filter: { and: [], or: [deepOr] } as never,
        }),
      ).toThrowError(/fields:.*filter/);
    });

    test("rejects breadth-DoS: a single group with too many children", () => {
      const wide = Array.from({ length: 1000 }, () => ({
        member: "region",
        operator: "equals" as const,
        values: ["EMEA"],
      }));
      expect(() =>
        validateMetricRequest({ measures: ["arr"], filter: { and: wide } }),
      ).toThrowError(/fields:.*filter/);
    });
  });

  describe("parameterization safety (no values in rendered SQL)", () => {
    test("string values do not appear verbatim in the SQL string", () => {
      const sneaky = "EMEA' OR '1'='1";
      const { statement } = render({
        member: "region",
        operator: "equals",
        values: [sneaky],
      });
      expect(statement).not.toContain(sneaky);
      expect(statement).toContain(":f_0");
    });

    test("numeric values do not appear verbatim in the SQL string", () => {
      const { statement } = render({
        member: "deal_size",
        operator: "gt",
        values: [987654321],
      });
      expect(statement).not.toContain("987654321");
      expect(statement).toContain(":f_0");
    });

    test("LIKE wildcard is the only value transformation; the original string is not in SQL", () => {
      const { statement } = render({
        member: "region",
        operator: "contains",
        values: ["dangerous%"],
      });
      expect(statement).not.toContain("dangerous");
      expect(statement).toContain(":f_0");
    });

    test("IN values are individually bound (not concatenated)", () => {
      const { statement, parameters } = render({
        member: "region",
        operator: "in",
        values: ["A", "B", "C"],
      });
      expect(statement).not.toMatch(/region IN \([^:]/);
      expect(Object.keys(parameters)).toHaveLength(3);
    });

    test("a filter member failing DIMENSION_NAME_PATTERN throws before SQL is built", () => {
      expect(() =>
        render({
          member: "region; DROP TABLE foo --",
          operator: "equals",
          values: ["x"],
        }),
      ).toThrowError(/not a valid identifier/);
    });
  });

  describe("validator — operator + cardinality (registry-free)", () => {
    test("rejects an unknown operator", () => {
      expect(() =>
        validateMetricRequest({
          measures: ["arr"],
          filter: {
            member: "region",
            operator: "startsWith" as never,
            values: ["E"],
          },
        }),
      ).toThrowError(/fields:.*filter\.operator/);
    });

    test("rejects equals with zero values (cardinality)", () => {
      expect(() =>
        validateMetricRequest({
          measures: ["arr"],
          filter: { member: "region", operator: "equals", values: [] },
        }),
      ).toThrowError(/fields:.*filter\.values/);
    });

    test("rejects equals with multiple values (cardinality)", () => {
      expect(() =>
        validateMetricRequest({
          measures: ["arr"],
          filter: { member: "region", operator: "equals", values: ["A", "B"] },
        }),
      ).toThrowError(/fields:.*filter\.values/);
    });

    test("rejects in with empty values (cardinality)", () => {
      expect(() =>
        validateMetricRequest({
          measures: ["arr"],
          filter: { member: "region", operator: "in", values: [] },
        }),
      ).toThrowError(/fields:.*filter\.values/);
    });

    test("rejects set with values (cardinality — must be absent)", () => {
      expect(() =>
        validateMetricRequest({
          measures: ["arr"],
          filter: { member: "region", operator: "set", values: ["EMEA"] },
        }),
      ).toThrowError(/fields:.*filter\.values/);
    });

    test("accepts set with no values", () => {
      expect(() =>
        validateMetricRequest({
          measures: ["arr"],
          filter: { member: "region", operator: "set" },
        }),
      ).not.toThrow();
    });

    test("accepts notSet with an empty values array", () => {
      expect(() =>
        validateMetricRequest({
          measures: ["arr"],
          filter: { member: "region", operator: "notSet", values: [] },
        }),
      ).not.toThrow();
    });

    test("rejects `contains` with a non-string value", () => {
      expect(() =>
        validateMetricRequest({
          measures: ["arr"],
          filter: {
            member: "region",
            operator: "contains",
            values: [42 as unknown as string],
          },
        }),
      ).toThrowError(/fields:.*filter\.values/);
    });

    test("rejects a filter predicate with too many values (DoS guard)", () => {
      const big = Array.from({ length: 2000 }, (_, i) => `v${i}`);
      expect(() =>
        validateMetricRequest({
          measures: ["arr"],
          filter: { member: "region", operator: "in", values: big },
        }),
      ).toThrowError(/fields:.*filter\.values/);
    });

    test("rejects a bare-array filter (not a Predicate or { and }/{ or } group)", () => {
      expect(() =>
        validateMetricRequest({
          measures: ["arr"],
          filter: [
            { member: "region", operator: "in", values: ["EMEA"] },
          ] as never,
        }),
      ).toThrow();
    });

    test("rejects empty `or` group (empty disjunction is vacuously false)", () => {
      expect(() =>
        validateMetricRequest({
          measures: ["arr"],
          filter: { or: [] },
        }),
      ).toThrowError(/fields:.*filter\.or/);
    });

    test("accepts empty `and` group (no constraint contributed)", () => {
      expect(() =>
        validateMetricRequest({
          measures: ["arr"],
          filter: { and: [] },
        }),
      ).not.toThrow();
    });

    test("rejects an unknown operator at depth (nested filter)", () => {
      expect(() =>
        validateMetricRequest({
          measures: ["arr"],
          filter: {
            and: [
              { member: "region", operator: "equals", values: ["EMEA"] },
              {
                member: "segment",
                operator: "matches" as never,
                values: ["X"],
              },
            ],
          },
        }),
      ).toThrowError(/fields:.*filter\.and\.1\.operator/);
    });

    test("well-formed-but-unknown member is NOT rejected locally (no allowlist)", () => {
      // The dropped-allowlist posture: a grammar-valid member that isn't a
      // real dimension passes validation AND SQL construction — it reaches the
      // warehouse, which is the authority on whether the column exists.
      expect(() =>
        validateMetricRequest({
          measures: ["arr"],
          filter: { member: "ghost_column", operator: "equals", values: ["x"] },
        }),
      ).not.toThrow();
      const { where } = render({
        member: "ghost_column",
        operator: "equals",
        values: ["x"],
      });
      expect(where).toBe("ghost_column = :f_0");
    });
  });

  describe("timeGrain + timeDimension (validator)", () => {
    test("a grammar-valid timeGrain + timeDimension (in dimensions) is accepted", () => {
      expect(() =>
        validateMetricRequest({
          measures: ["arr"],
          dimensions: ["order_date"],
          timeGrain: "month",
          timeDimension: "order_date",
        }),
      ).not.toThrow();
    });

    test("a timeGrain failing TIME_GRAIN_PATTERN is rejected", () => {
      expect(() =>
        validateMetricRequest({
          measures: ["arr"],
          dimensions: ["order_date"],
          timeGrain: "MONTH; DROP TABLE t",
          timeDimension: "order_date",
        }),
      ).toThrowError(/fields:.*timeGrain/);
    });

    test("a capitalized grain (Month) is rejected by the grammar gate", () => {
      expect(() =>
        validateMetricRequest({
          measures: ["arr"],
          dimensions: ["order_date"],
          timeGrain: "Month",
          timeDimension: "order_date",
        }),
      ).toThrowError(/fields:.*timeGrain/);
    });

    test("a timeDimension failing DIMENSION_NAME_PATTERN is rejected", () => {
      expect(() =>
        validateMetricRequest({
          measures: ["arr"],
          dimensions: ["order_date"],
          timeGrain: "month",
          timeDimension: "order_date; DROP TABLE t",
        }),
      ).toThrowError(/fields:.*timeDimension/);
    });

    test("timeGrain without timeDimension → 400 (grain requires a target)", () => {
      expect(() =>
        validateMetricRequest({
          measures: ["arr"],
          dimensions: ["order_date"],
          timeGrain: "day",
        }),
      ).toThrowError(/fields:.*timeDimension/);
    });

    test("timeDimension not in dimensions → 400 (must be selectable + in GROUP BY ALL)", () => {
      expect(() =>
        validateMetricRequest({
          measures: ["arr"],
          dimensions: ["region"],
          timeGrain: "month",
          timeDimension: "order_date",
        }),
      ).toThrowError(/fields:.*timeDimension/);
    });

    test("timeDimension not in dimensions → 400 even without timeGrain", () => {
      // The dimensions-membership rule holds independent of timeGrain: a
      // timeDimension that isn't selected can never be bucketed or grouped.
      expect(() =>
        validateMetricRequest({
          measures: ["arr"],
          dimensions: ["region"],
          timeDimension: "order_date",
        }),
      ).toThrowError(/fields:.*timeDimension/);
    });
  });

  describe("sort-before-hash (predicate ordering inside groups)", () => {
    test("predicate order does not affect the rendered SQL within an AND group", () => {
      const a = render({
        and: [
          { member: "region", operator: "equals", values: ["EMEA"] },
          { member: "segment", operator: "equals", values: ["Ent"] },
        ],
      });
      const b = render({
        and: [
          { member: "segment", operator: "equals", values: ["Ent"] },
          { member: "region", operator: "equals", values: ["EMEA"] },
        ],
      });
      expect(a.where).toBe(b.where);
    });
  });

  // The warehouse-authoritative unknown-name parity test (sanitized
  // clientMessage/errorCode envelope) lands here because the Phase 1 harness
  // can drive the metric route end-to-end and assert on the SSE error bytes.
  describe("warehouse-authoritative unknown-name parity", () => {
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

    test("a well-formed-but-unknown measure reaches the warehouse and surfaces a sanitized error envelope", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();
      setRegistry(plugin, {
        revenue: {
          key: "revenue",
          source: "cat.sch.revenue_metrics",
          lane: "sp",
        },
      });

      // The warehouse rejects the unknown column. The raw text carries the
      // offending name; the connector wraps it in an ExecutionError whose
      // `.message` is server-log-only and whose `clientMessage` is sanitized.
      const { ExecutionError } = await import("../../../errors/execution");
      const rawWarehouseText =
        "[UNRESOLVED_COLUMN] A column with name `ghost_measure` cannot be resolved";
      const executeMock = vi
        .fn()
        .mockRejectedValue(
          ExecutionError.statementFailed(rawWarehouseText, "UNRESOLVED_COLUMN"),
        );
      (plugin as any).SQLClient.executeStatement = executeMock;

      plugin.injectRoutes(router);
      const handler = getHandler("POST", "/metric/:key");
      const mockReq = createMockRequest({
        params: { key: "revenue" },
        // grammar-valid, but not a real measure — NOT rejected locally.
        body: { measures: ["ghost_measure"] },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      // The well-formed-unknown measure was NOT rejected locally — it reached
      // the warehouse (parity with the raw `.sql` flow).
      expect(executeMock).toHaveBeenCalled();
      expect(executeMock.mock.calls[0][1]).toEqual(
        expect.objectContaining({
          statement:
            "SELECT MEASURE(ghost_measure) AS ghost_measure FROM cat.sch.revenue_metrics",
        }),
      );

      // The SSE error envelope carries a sanitized clientMessage + structured
      // errorCode — the raw warehouse text (with the offending column name)
      // never reaches the client payload (#329 scrubbing, inherited).
      const errorWrites = (mockRes.write as any).mock.calls
        .map((call: any[]) => call[0] as string)
        .filter((s: string) => s.startsWith("data: "));
      const errorPayload = errorWrites.find((s: string) =>
        s.includes('"errorCode"'),
      );
      expect(errorPayload).toBeTruthy();
      expect(errorPayload).toContain('"errorCode":"UNRESOLVED_COLUMN"');
      expect(errorPayload).toContain('"error":"Query execution failed"');
      expect(errorPayload).not.toContain("ghost_measure");
      expect(errorPayload).not.toContain("UNRESOLVED_COLUMN]");
    });
  });
});

// ── Phase 3: cache-key composition. `composeMetricCacheKey` produces the
// array `CacheManager.generateKey` concatenates + sha256s; the invariants
// below are what make the cache both correct (semantically equal calls collapse)
// and safe (distinct args / executors never collide).
describe("composeMetricCacheKey", () => {
  const base: {
    metricKey: string;
    measures: string[];
    format: string;
    executorKey: string;
  } = {
    metricKey: "revenue",
    measures: ["arr"],
    format: "JSON_ARRAY",
    executorKey: "sp",
  };

  test("measure ORDER does not affect the key (sorted before hashing)", () => {
    const a = composeMetricCacheKey({
      ...base,
      measures: ["arr", "revenue"],
    });
    const b = composeMetricCacheKey({
      ...base,
      measures: ["revenue", "arr"],
    });
    expect(a).toEqual(b);
  });

  test("dimension ORDER does not affect the key (sorted before hashing)", () => {
    const a = composeMetricCacheKey({
      ...base,
      dimensions: ["region", "segment"],
    });
    const b = composeMetricCacheKey({
      ...base,
      dimensions: ["segment", "region"],
    });
    expect(a).toEqual(b);
  });

  test("different measures → different keys", () => {
    const a = composeMetricCacheKey({ ...base, measures: ["arr"] });
    const b = composeMetricCacheKey({ ...base, measures: ["mrr"] });
    expect(a).not.toEqual(b);
  });

  test("different dimensions → different keys", () => {
    const a = composeMetricCacheKey({ ...base, dimensions: ["region"] });
    const b = composeMetricCacheKey({ ...base, dimensions: ["segment"] });
    expect(a).not.toEqual(b);
  });

  test("different timeGrain → different keys", () => {
    const a = composeMetricCacheKey({
      ...base,
      dimensions: ["order_date"],
      timeGrain: "day",
      timeDimension: "order_date",
    });
    const b = composeMetricCacheKey({
      ...base,
      dimensions: ["order_date"],
      timeGrain: "month",
      timeDimension: "order_date",
    });
    expect(a).not.toEqual(b);
  });

  test("different timeDimension → different keys (new field salts the key)", () => {
    const a = composeMetricCacheKey({
      ...base,
      dimensions: ["order_date", "ship_date"],
      timeGrain: "day",
      timeDimension: "order_date",
    });
    const b = composeMetricCacheKey({
      ...base,
      dimensions: ["order_date", "ship_date"],
      timeGrain: "day",
      timeDimension: "ship_date",
    });
    expect(a).not.toEqual(b);
  });

  test("different limit → different keys", () => {
    const a = composeMetricCacheKey({ ...base, limit: 10 });
    const b = composeMetricCacheKey({ ...base, limit: 20 });
    expect(a).not.toEqual(b);
  });

  test("predicate ORDER inside a group does not affect the key (canonicalizeFilter)", () => {
    const a = composeMetricCacheKey({
      ...base,
      filter: {
        and: [
          { member: "region", operator: "equals", values: ["EMEA"] },
          { member: "segment", operator: "equals", values: ["Ent"] },
        ],
      } as MetricFilter,
    });
    const b = composeMetricCacheKey({
      ...base,
      filter: {
        and: [
          { member: "segment", operator: "equals", values: ["Ent"] },
          { member: "region", operator: "equals", values: ["EMEA"] },
        ],
      } as MetricFilter,
    });
    expect(a).toEqual(b);
  });

  test("distinct filter VALUES → distinct keys", () => {
    const a = composeMetricCacheKey({
      ...base,
      filter: {
        member: "region",
        operator: "equals",
        values: ["EMEA"],
      } as MetricFilter,
    });
    const b = composeMetricCacheKey({
      ...base,
      filter: {
        member: "region",
        operator: "equals",
        values: ["APAC"],
      } as MetricFilter,
    });
    expect(a).not.toEqual(b);
  });

  test("a filter present vs absent → different keys", () => {
    const withFilter = composeMetricCacheKey({
      ...base,
      filter: {
        member: "region",
        operator: "set",
      } as MetricFilter,
    });
    const withoutFilter = composeMetricCacheKey({ ...base });
    expect(withFilter).not.toEqual(withoutFilter);
  });

  test("SP vs OBO (same args) → different keys via executorKey", () => {
    const sp = composeMetricCacheKey({ ...base, executorKey: "sp" });
    const obo = composeMetricCacheKey({
      ...base,
      executorKey: deriveMetricExecutorKey({
        lane: "obo",
        userIdentity: "alice",
      }),
    });
    expect(sp).not.toEqual(obo);
  });
});

// ── Phase 3: executor-key isolation. The key is what scopes the cache — `"sp"`
// shares it across all callers, a per-user hash isolates OBO callers. The raw
// identity must never enter the key verbatim (privacy: cache keys are logged
// and persisted).
describe("deriveMetricExecutorKey", () => {
  test("SP lane → literal 'sp' (shared cache)", () => {
    expect(deriveMetricExecutorKey({ lane: "sp" })).toBe("sp");
  });

  test("SP lane ignores any supplied identity", () => {
    expect(deriveMetricExecutorKey({ lane: "sp", userIdentity: "alice" })).toBe(
      "sp",
    );
  });

  test("OBO lane hashes the identity — raw identity never appears in the key", () => {
    const key = deriveMetricExecutorKey({
      lane: "obo",
      userIdentity: "alice@example.com",
    });
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key).not.toContain("alice");
  });

  test("OBO same identity → stable key (cache hits work)", () => {
    const a = deriveMetricExecutorKey({ lane: "obo", userIdentity: "alice" });
    const b = deriveMetricExecutorKey({ lane: "obo", userIdentity: "alice" });
    expect(a).toBe(b);
  });

  test("OBO identity is trimmed before hashing (whitespace does not fork the scope)", () => {
    const padded = deriveMetricExecutorKey({
      lane: "obo",
      userIdentity: "  alice  ",
    });
    const bare = deriveMetricExecutorKey({
      lane: "obo",
      userIdentity: "alice",
    });
    expect(padded).toBe(bare);
  });

  test("OBO different identities → different keys (isolation holds)", () => {
    const alice = deriveMetricExecutorKey({
      lane: "obo",
      userIdentity: "alice",
    });
    const bob = deriveMetricExecutorKey({ lane: "obo", userIdentity: "bob" });
    expect(alice).not.toBe(bob);
  });

  test("OBO empty identity → throws AuthenticationError (no shared 'anonymous' scope)", () => {
    expect(() =>
      deriveMetricExecutorKey({ lane: "obo", userIdentity: "" }),
    ).toThrow(AuthenticationError);
  });

  test("OBO whitespace-only identity → throws AuthenticationError", () => {
    expect(() =>
      deriveMetricExecutorKey({ lane: "obo", userIdentity: "   " }),
    ).toThrow(AuthenticationError);
  });

  test("OBO missing (undefined/null) identity → throws AuthenticationError", () => {
    expect(() => deriveMetricExecutorKey({ lane: "obo" })).toThrow(
      AuthenticationError,
    );
    expect(() =>
      deriveMetricExecutorKey({ lane: "obo", userIdentity: null }),
    ).toThrow(AuthenticationError);
  });
});

// ── Phase 3: lane dispatch at the handler level. The lane comes from the
// registration (the entry's `executor` in metric-views.json), NOT the URL:
// OBO-lane routes through `asUser(req)`, SP-lane through the default executor.
// A missing/whitespace OBO identity must land on the canonical 401 envelope,
// never an out-of-envelope 500.
describe("metric route — lane dispatch (Phase 3)", () => {
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

  test("OBO-lane registration routes through asUser(req)", async () => {
    const plugin = new AnalyticsPlugin(config);
    const { router, getHandler } = createMockRouter();
    setRegistry(plugin, {
      revenue: {
        key: "revenue",
        source: "cat.sch.revenue_metrics",
        lane: "obo",
      },
    });

    const asUserSpy = vi.spyOn(plugin, "asUser");
    const executeMock = vi
      .fn()
      .mockResolvedValue({ result: { data: [{ arr: 1 }] } });
    (plugin as any).SQLClient.executeStatement = executeMock;

    plugin.injectRoutes(router);
    const handler = getHandler("POST", "/metric/:key");
    const mockReq = createMockRequest({
      params: { key: "revenue" },
      body: { measures: ["arr"] },
      headers: {
        "x-forwarded-access-token": "user-token",
        "x-forwarded-user": "alice",
      },
    });
    const mockRes = createMockResponse();

    await handler(mockReq, mockRes);

    // The OBO lane dispatched through the user-scoped executor…
    expect(asUserSpy).toHaveBeenCalledWith(mockReq);
    // …and the SQL still reached the warehouse and streamed a result.
    expect(executeMock).toHaveBeenCalled();
    expect(mockRes.write).toHaveBeenCalledWith("event: result\n");
  });

  test("SP-lane registration uses the default executor (asUser not called)", async () => {
    const plugin = new AnalyticsPlugin(config);
    const { router, getHandler } = createMockRouter();
    setRegistry(plugin, {
      revenue: {
        key: "revenue",
        source: "cat.sch.revenue_metrics",
        lane: "sp",
      },
    });

    const asUserSpy = vi.spyOn(plugin, "asUser");
    const executeMock = vi
      .fn()
      .mockResolvedValue({ result: { data: [{ arr: 1 }] } });
    (plugin as any).SQLClient.executeStatement = executeMock;

    plugin.injectRoutes(router);
    const handler = getHandler("POST", "/metric/:key");
    const mockReq = createMockRequest({
      params: { key: "revenue" },
      body: { measures: ["arr"] },
      // Even with user headers present, an SP-lane metric must NOT impersonate.
      headers: {
        "x-forwarded-access-token": "user-token",
        "x-forwarded-user": "alice",
      },
    });
    const mockRes = createMockResponse();

    await handler(mockReq, mockRes);

    expect(asUserSpy).not.toHaveBeenCalled();
    expect(executeMock).toHaveBeenCalled();
    expect(mockRes.write).toHaveBeenCalledWith("event: result\n");
  });

  test("OBO metric with no user identity → canonical 401, no SQL executed", async () => {
    const plugin = new AnalyticsPlugin(config);
    const { router, getHandler } = createMockRouter();
    setRegistry(plugin, {
      revenue: {
        key: "revenue",
        source: "cat.sch.revenue_metrics",
        lane: "obo",
      },
    });

    const executeMock = vi.fn();
    (plugin as any).SQLClient.executeStatement = executeMock;

    plugin.injectRoutes(router);
    const handler = getHandler("POST", "/metric/:key");
    // No x-forwarded-* headers at all → the OBO dispatch throws an
    // AuthenticationError, caught and returned as a canonical 401 envelope.
    const mockReq = createMockRequest({
      params: { key: "revenue" },
      body: { measures: ["arr"] },
    });
    const mockRes = createMockResponse();

    await handler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "AUTHENTICATION_ERROR" }),
    );
    // Landed on the 401 path before any SQL and without opening the SSE stream.
    expect(executeMock).not.toHaveBeenCalled();
    expect(mockRes.write).not.toHaveBeenCalled();
  });

  test("OBO metric with whitespace-only user identity → canonical 401", async () => {
    const plugin = new AnalyticsPlugin(config);
    const { router, getHandler } = createMockRouter();
    setRegistry(plugin, {
      revenue: {
        key: "revenue",
        source: "cat.sch.revenue_metrics",
        lane: "obo",
      },
    });

    const executeMock = vi.fn();
    (plugin as any).SQLClient.executeStatement = executeMock;

    plugin.injectRoutes(router);
    const handler = getHandler("POST", "/metric/:key");
    const mockReq = createMockRequest({
      params: { key: "revenue" },
      body: { measures: ["arr"] },
      headers: {
        "x-forwarded-access-token": "user-token",
        "x-forwarded-user": "   ",
      },
    });
    const mockRes = createMockResponse();

    await handler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "AUTHENTICATION_ERROR" }),
    );
    expect(executeMock).not.toHaveBeenCalled();
  });
});
