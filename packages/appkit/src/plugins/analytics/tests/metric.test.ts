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
import {
  buildMetricSql,
  composeMetricCacheKey,
  loadMetricRegistry,
  makeMetricRequestSchema,
  validateMetricRequest,
} from "../metric";
import type { IAnalyticsConfig, MetricRegistration } from "../types";

// Mirror the analytics test cache mock so the interceptor chain wiring is
// real but storage is in-memory and synchronous.
const { mockCacheStore, mockCacheInstance } = vi.hoisted(() => {
  const store = new Map<string, unknown>();

  const generateKey = (parts: unknown[], userKey: string): string => {
    const { createHash } = require("node:crypto");
    const allParts = [userKey, ...parts];
    const serialized = JSON.stringify(allParts);
    return createHash("sha256").update(serialized).digest("hex");
  };

  const instance = {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    getOrExecute: vi.fn(
      async (key: unknown[], fn: () => Promise<unknown>, userKey: string) => {
        const cacheKey = generateKey(key, userKey);
        if (store.has(cacheKey)) {
          return store.get(cacheKey);
        }
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

const REVENUE_REGISTRATION: MetricRegistration = {
  key: "revenue",
  source: "appkit_demo.public.revenue_metrics",
  lane: "sp",
  knownMeasures: ["arr", "mrr"],
  knownDimensions: ["region", "segment", "created_at"],
  knownTimeGrainsByDim: {
    created_at: ["day", "month", "week"],
  },
};

describe("metric — pure helpers", () => {
  describe("makeMetricRequestSchema / validateMetricRequest", () => {
    test("accepts a request with a known measure", () => {
      const parsed = validateMetricRequest(REVENUE_REGISTRATION, {
        measures: ["arr"],
      });
      expect(parsed.measures).toEqual(["arr"]);
      expect(parsed.format).toBeUndefined();
    });

    test("accepts format=ARROW (handled, even if hook discourages it)", () => {
      const parsed = validateMetricRequest(REVENUE_REGISTRATION, {
        measures: ["arr"],
        format: "ARROW",
      });
      expect(parsed.format).toBe("ARROW");
    });

    test("rejects an unknown measure with a clear error", () => {
      expect(() =>
        validateMetricRequest(REVENUE_REGISTRATION, {
          measures: ["bogus"],
        }),
      ).toThrowError(/measures\.0/);
    });

    test("rejects an empty measures array", () => {
      expect(() =>
        validateMetricRequest(REVENUE_REGISTRATION, {
          measures: [],
        }),
      ).toThrowError(/measures must contain at least one entry/);
    });

    test("rejects a non-positive limit", () => {
      expect(() =>
        validateMetricRequest(REVENUE_REGISTRATION, {
          measures: ["arr"],
          limit: -1,
        }),
      ).toThrowError(/limit must be positive/);
    });

    test("rejects unknown top-level fields (strict)", () => {
      expect(() =>
        validateMetricRequest(REVENUE_REGISTRATION, {
          measures: ["arr"],
          // 'filter' is reserved for Phase 3; the strict() schema must reject it.
          filter: [{ member: "region", operator: "in", values: ["EMEA"] }],
        } as any),
      ).toThrowError();
    });

    test("falls open when knownMeasures is empty", () => {
      const looseRegistration: MetricRegistration = {
        ...REVENUE_REGISTRATION,
        knownMeasures: [],
      };
      const parsed = validateMetricRequest(looseRegistration, {
        measures: ["anything"],
      });
      expect(parsed.measures).toEqual(["anything"]);
    });

    test("schema construction is stable across calls", () => {
      const a = makeMetricRequestSchema(REVENUE_REGISTRATION);
      const b = makeMetricRequestSchema(REVENUE_REGISTRATION);
      expect(a.safeParse({ measures: ["arr"] }).success).toBe(true);
      expect(b.safeParse({ measures: ["arr"] }).success).toBe(true);
    });

    // ── Phase 2: dimensions ─────────────────────────────────────────────
    test("accepts a request with known dimensions", () => {
      const parsed = validateMetricRequest(REVENUE_REGISTRATION, {
        measures: ["arr"],
        dimensions: ["region"],
      });
      expect(parsed.dimensions).toEqual(["region"]);
    });

    test("accepts an empty dimensions array (ungrouped)", () => {
      const parsed = validateMetricRequest(REVENUE_REGISTRATION, {
        measures: ["arr"],
        dimensions: [],
      });
      expect(parsed.dimensions).toEqual([]);
    });

    test("rejects an unknown dimension with a clear error", () => {
      expect(() =>
        validateMetricRequest(REVENUE_REGISTRATION, {
          measures: ["arr"],
          dimensions: ["nonexistent"],
        }),
      ).toThrowError(/dimensions\.0/);
    });

    test("falls open on dimensions when knownDimensions is empty", () => {
      const looseRegistration: MetricRegistration = {
        ...REVENUE_REGISTRATION,
        knownDimensions: [],
        knownTimeGrainsByDim: {},
      };
      const parsed = validateMetricRequest(looseRegistration, {
        measures: ["arr"],
        dimensions: ["any_column"],
      });
      expect(parsed.dimensions).toEqual(["any_column"]);
    });

    // ── Phase 2: time grain ─────────────────────────────────────────────
    test("accepts a known timeGrain when a time-typed dim is present", () => {
      const parsed = validateMetricRequest(REVENUE_REGISTRATION, {
        measures: ["arr"],
        dimensions: ["created_at"],
        timeGrain: "month",
      });
      expect(parsed.timeGrain).toBe("month");
    });

    test("rejects a timeGrain not in the metric's allowed enum", () => {
      expect(() =>
        validateMetricRequest(REVENUE_REGISTRATION, {
          measures: ["arr"],
          dimensions: ["created_at"],
          timeGrain: "year",
        }),
      ).toThrowError(/timeGrain must be one of/);
    });

    test("rejects timeGrain when no time-typed dim is in dimensions", () => {
      expect(() =>
        validateMetricRequest(REVENUE_REGISTRATION, {
          measures: ["arr"],
          dimensions: ["region"],
          timeGrain: "month",
        }),
      ).toThrowError(/no time-typed dimension/);
    });

    test("rejects timeGrain when dimensions is omitted entirely", () => {
      expect(() =>
        validateMetricRequest(REVENUE_REGISTRATION, {
          measures: ["arr"],
          timeGrain: "month",
        }),
      ).toThrowError(/no time-typed dimension/);
    });

    test("rejects timeGrain when the metric view has no time-typed dims", () => {
      const noTimeRegistration: MetricRegistration = {
        ...REVENUE_REGISTRATION,
        knownDimensions: ["region", "segment"],
        knownTimeGrainsByDim: {},
      };
      expect(() =>
        validateMetricRequest(noTimeRegistration, {
          measures: ["arr"],
          dimensions: ["region"],
          timeGrain: "month",
        }),
      ).toThrowError();
    });
  });

  describe("buildMetricSql", () => {
    test("renders SELECT MEASURE(<m>) FROM <fqn>", () => {
      const { statement, parameters } = buildMetricSql(REVENUE_REGISTRATION, {
        measures: ["arr"],
      });
      expect(statement).toBe(
        "SELECT MEASURE(arr) FROM appkit_demo.public.revenue_metrics",
      );
      expect(parameters).toEqual([]);
    });

    test("sorts measures lexicographically for deterministic SQL", () => {
      const { statement } = buildMetricSql(REVENUE_REGISTRATION, {
        measures: ["mrr", "arr"],
      });
      expect(statement).toBe(
        "SELECT MEASURE(arr), MEASURE(mrr) FROM appkit_demo.public.revenue_metrics",
      );
    });

    test("appends LIMIT clause when limit is provided", () => {
      const { statement } = buildMetricSql(REVENUE_REGISTRATION, {
        measures: ["arr"],
        limit: 10,
      });
      expect(statement).toBe(
        "SELECT MEASURE(arr) FROM appkit_demo.public.revenue_metrics LIMIT 10",
      );
    });

    test("rejects unknown measures (defense in depth past the validator)", () => {
      expect(() =>
        buildMetricSql(REVENUE_REGISTRATION, {
          measures: ["bogus"],
        }),
      ).toThrowError(/unknown measure/i);
    });

    test("rejects measures that are not valid identifiers", () => {
      const looseRegistration: MetricRegistration = {
        ...REVENUE_REGISTRATION,
        knownMeasures: [],
      };
      expect(() =>
        buildMetricSql(looseRegistration, {
          measures: ["arr; DROP TABLE foo --"],
        }),
      ).toThrowError(/not a valid identifier/);
    });

    test("rejects FQNs that are not three-part", () => {
      const badRegistration: MetricRegistration = {
        ...REVENUE_REGISTRATION,
        source: "some.bad",
        knownMeasures: ["arr"],
      };
      expect(() =>
        buildMetricSql(badRegistration, { measures: ["arr"] }),
      ).toThrowError(/three-part UC FQN/);
    });

    test("rejects empty measures", () => {
      expect(() =>
        buildMetricSql(REVENUE_REGISTRATION, { measures: [] }),
      ).toThrowError(/at least one measure/);
    });

    // ── Phase 2: dimensions + GROUP BY ALL ──────────────────────────────
    test("emits GROUP BY ALL when dimensions are present (snapshot — measures-only Phase 1 case)", () => {
      const { statement } = buildMetricSql(REVENUE_REGISTRATION, {
        measures: ["arr"],
      });
      expect(statement).toMatchInlineSnapshot(
        `"SELECT MEASURE(arr) FROM appkit_demo.public.revenue_metrics"`,
      );
    });

    test("emits dimensions + GROUP BY ALL (snapshot — dims-only)", () => {
      const { statement } = buildMetricSql(REVENUE_REGISTRATION, {
        measures: ["arr"],
        dimensions: ["region"],
      });
      expect(statement).toMatchInlineSnapshot(
        `"SELECT MEASURE(arr), region FROM appkit_demo.public.revenue_metrics GROUP BY ALL"`,
      );
    });

    test("emits date_trunc for time-typed dim with timeGrain (snapshot — dims+time-grain)", () => {
      const { statement } = buildMetricSql(REVENUE_REGISTRATION, {
        measures: ["arr"],
        dimensions: ["created_at", "region"],
        timeGrain: "month",
      });
      expect(statement).toMatchInlineSnapshot(
        `"SELECT MEASURE(arr), date_trunc('month', created_at) AS created_at, region FROM appkit_demo.public.revenue_metrics GROUP BY ALL"`,
      );
    });

    test("emits dims + time-grain + limit together (snapshot — dims+time-grain+limit)", () => {
      const { statement } = buildMetricSql(REVENUE_REGISTRATION, {
        measures: ["arr", "mrr"],
        dimensions: ["created_at"],
        timeGrain: "week",
        limit: 50,
      });
      expect(statement).toMatchInlineSnapshot(
        `"SELECT MEASURE(arr), MEASURE(mrr), date_trunc('week', created_at) AS created_at FROM appkit_demo.public.revenue_metrics GROUP BY ALL LIMIT 50"`,
      );
    });

    test("does not wrap regular (non-time) dims in date_trunc when timeGrain is set", () => {
      const { statement } = buildMetricSql(REVENUE_REGISTRATION, {
        measures: ["arr"],
        dimensions: ["region", "created_at"],
        timeGrain: "day",
      });
      // Only created_at is wrapped; region renders as the bare column.
      expect(statement).toContain("date_trunc('day', created_at)");
      expect(statement).toContain(", region");
      expect(statement).not.toContain("date_trunc('day', region)");
    });

    test("rejects unknown dimensions (defense in depth past the validator)", () => {
      expect(() =>
        buildMetricSql(REVENUE_REGISTRATION, {
          measures: ["arr"],
          dimensions: ["nonexistent"],
        }),
      ).toThrowError(/unknown dimension/i);
    });

    test("rejects dimensions that are not valid identifiers", () => {
      const looseRegistration: MetricRegistration = {
        ...REVENUE_REGISTRATION,
        knownDimensions: [],
        knownTimeGrainsByDim: {},
      };
      expect(() =>
        buildMetricSql(looseRegistration, {
          measures: ["arr"],
          dimensions: ["region; DROP TABLE foo --"],
        }),
      ).toThrowError(/not a valid identifier/);
    });

    test("rejects unknown timeGrain values", () => {
      expect(() =>
        buildMetricSql(REVENUE_REGISTRATION, {
          measures: ["arr"],
          dimensions: ["created_at"],
          timeGrain: "year",
        }),
      ).toThrowError(/unknown timeGrain/i);
    });

    test("rejects timeGrain when no time-typed dim is in dimensions", () => {
      expect(() =>
        buildMetricSql(REVENUE_REGISTRATION, {
          measures: ["arr"],
          dimensions: ["region"],
          timeGrain: "month",
        }),
      ).toThrowError(/no time-typed dimension/);
    });

    test("rejects timeGrain values that do not match the safe token shape", () => {
      expect(() =>
        buildMetricSql(REVENUE_REGISTRATION, {
          measures: ["arr"],
          dimensions: ["created_at"],
          timeGrain: "Month' OR 1=1 --",
        }),
      ).toThrowError(/not a valid grain token/);
    });

    test("sorts dimensions lexicographically for deterministic SQL", () => {
      const { statement } = buildMetricSql(REVENUE_REGISTRATION, {
        measures: ["arr"],
        dimensions: ["segment", "region"],
      });
      // region comes before segment alphabetically.
      expect(statement).toBe(
        "SELECT MEASURE(arr), region, segment FROM appkit_demo.public.revenue_metrics GROUP BY ALL",
      );
    });
  });

  describe("composeMetricCacheKey", () => {
    test("reserves the metric: namespace prefix", () => {
      const key = composeMetricCacheKey({
        metricKey: "revenue",
        measures: ["arr"],
        format: "JSON",
        executorKey: "sp",
      });
      expect(key[0]).toBe("metric");
    });

    test("normalizes measure order for cache hits across equivalent calls", () => {
      const a = composeMetricCacheKey({
        metricKey: "revenue",
        measures: ["arr", "mrr"],
        format: "JSON",
        executorKey: "sp",
      });
      const b = composeMetricCacheKey({
        metricKey: "revenue",
        measures: ["mrr", "arr"],
        format: "JSON",
        executorKey: "sp",
      });
      expect(a).toEqual(b);
    });

    test("differentiates SP vs OBO via executorKey", () => {
      const sp = composeMetricCacheKey({
        metricKey: "revenue",
        measures: ["arr"],
        format: "JSON",
        executorKey: "sp",
      });
      const obo = composeMetricCacheKey({
        metricKey: "revenue",
        measures: ["arr"],
        format: "JSON",
        executorKey: "user-1",
      });
      expect(sp).not.toEqual(obo);
    });

    test("differentiates calls with different limit values", () => {
      const a = composeMetricCacheKey({
        metricKey: "revenue",
        measures: ["arr"],
        format: "JSON",
        executorKey: "sp",
        limit: 10,
      });
      const b = composeMetricCacheKey({
        metricKey: "revenue",
        measures: ["arr"],
        format: "JSON",
        executorKey: "sp",
        limit: 100,
      });
      expect(a).not.toEqual(b);
    });

    // ── Phase 2: dimensions + timeGrain ─────────────────────────────────
    test("normalizes dimension order for cache hits across equivalent calls", () => {
      const a = composeMetricCacheKey({
        metricKey: "revenue",
        measures: ["arr"],
        dimensions: ["region", "segment"],
        format: "JSON",
        executorKey: "sp",
      });
      const b = composeMetricCacheKey({
        metricKey: "revenue",
        measures: ["arr"],
        dimensions: ["segment", "region"],
        format: "JSON",
        executorKey: "sp",
      });
      expect(a).toEqual(b);
    });

    test("differentiates calls with different dimensions", () => {
      const a = composeMetricCacheKey({
        metricKey: "revenue",
        measures: ["arr"],
        dimensions: ["region"],
        format: "JSON",
        executorKey: "sp",
      });
      const b = composeMetricCacheKey({
        metricKey: "revenue",
        measures: ["arr"],
        dimensions: ["segment"],
        format: "JSON",
        executorKey: "sp",
      });
      expect(a).not.toEqual(b);
    });

    test("differentiates calls with different timeGrain values", () => {
      const a = composeMetricCacheKey({
        metricKey: "revenue",
        measures: ["arr"],
        dimensions: ["created_at"],
        timeGrain: "day",
        format: "JSON",
        executorKey: "sp",
      });
      const b = composeMetricCacheKey({
        metricKey: "revenue",
        measures: ["arr"],
        dimensions: ["created_at"],
        timeGrain: "month",
        format: "JSON",
        executorKey: "sp",
      });
      expect(a).not.toEqual(b);
    });

    test("differentiates a request with timeGrain from one without", () => {
      const withGrain = composeMetricCacheKey({
        metricKey: "revenue",
        measures: ["arr"],
        dimensions: ["created_at"],
        timeGrain: "day",
        format: "JSON",
        executorKey: "sp",
      });
      const withoutGrain = composeMetricCacheKey({
        metricKey: "revenue",
        measures: ["arr"],
        dimensions: ["created_at"],
        format: "JSON",
        executorKey: "sp",
      });
      expect(withGrain).not.toEqual(withoutGrain);
    });
  });
});

describe("loadMetricRegistry", () => {
  let tmpDir: string;

  beforeEach(async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "appkit-metric-test-"));
  });

  afterEach(async () => {
    const fs = await import("node:fs/promises");
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("returns an empty object when metric.json is absent", async () => {
    const registry = await loadMetricRegistry(undefined, tmpDir);
    expect(registry).toEqual({});
  });

  test("loads a basic metric.json with a single SP entry", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    await fs.writeFile(
      path.join(tmpDir, "metric.json"),
      JSON.stringify({
        sp: { revenue: { source: "demo.public.revenue" } },
      }),
    );
    const registry = await loadMetricRegistry(undefined, tmpDir);
    expect(registry.revenue).toEqual({
      key: "revenue",
      source: "demo.public.revenue",
      lane: "sp",
      knownMeasures: [],
      knownDimensions: [],
      knownTimeGrainsByDim: {},
    });
  });

  test("merges build-time metadata into knownMeasures/knownDimensions", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    await fs.writeFile(
      path.join(tmpDir, "metric.json"),
      JSON.stringify({
        sp: { revenue: { source: "demo.public.revenue" } },
      }),
    );
    const registry = await loadMetricRegistry(
      { revenue: { measures: ["arr"], dimensions: ["region"] } },
      tmpDir,
    );
    expect(registry.revenue.knownMeasures).toEqual(["arr"]);
    expect(registry.revenue.knownDimensions).toEqual(["region"]);
  });

  test("merges build-time time-grain metadata into knownTimeGrainsByDim", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    await fs.writeFile(
      path.join(tmpDir, "metric.json"),
      JSON.stringify({
        sp: { revenue: { source: "demo.public.revenue" } },
      }),
    );
    const registry = await loadMetricRegistry(
      {
        revenue: {
          measures: ["arr"],
          dimensions: ["region", "created_at"],
          timeGrainsByDim: { created_at: ["day", "month"] },
        },
      },
      tmpDir,
    );
    expect(registry.revenue.knownTimeGrainsByDim).toEqual({
      created_at: ["day", "month"],
    });
  });

  test("rejects unknown fields on entries (strict)", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    await fs.writeFile(
      path.join(tmpDir, "metric.json"),
      JSON.stringify({
        sp: {
          revenue: {
            source: "demo.public.revenue",
            cacheTtl: 60, // not allowed at v1
          },
        },
      }),
    );
    await expect(loadMetricRegistry(undefined, tmpDir)).rejects.toThrowError(
      /Invalid metric.json/,
    );
  });

  test("rejects bad FQN format", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    await fs.writeFile(
      path.join(tmpDir, "metric.json"),
      JSON.stringify({
        sp: { revenue: { source: "not.a.three.part" } },
      }),
    );
    await expect(loadMetricRegistry(undefined, tmpDir)).rejects.toThrowError(
      /three-part UC FQN/,
    );
  });

  test("rejects duplicate keys across sp/obo lanes", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    await fs.writeFile(
      path.join(tmpDir, "metric.json"),
      JSON.stringify({
        sp: { revenue: { source: "demo.public.revenue" } },
        obo: { revenue: { source: "demo.public.revenue" } },
      }),
    );
    await expect(loadMetricRegistry(undefined, tmpDir)).rejects.toThrowError(
      /Duplicate metric key/,
    );
  });

  test("rejects an obo entry with the same key as sp", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    await fs.writeFile(
      path.join(tmpDir, "metric.json"),
      JSON.stringify({
        sp: { foo: { source: "demo.public.foo" } },
        obo: { foo: { source: "demo.public.foo" } },
      }),
    );
    await expect(loadMetricRegistry(undefined, tmpDir)).rejects.toThrow();
  });

  test("rejects malformed JSON", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    await fs.writeFile(path.join(tmpDir, "metric.json"), "{not json");
    await expect(loadMetricRegistry(undefined, tmpDir)).rejects.toThrowError(
      /parse metric.json/,
    );
  });

  test("rejects metric keys that start with a digit", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    await fs.writeFile(
      path.join(tmpDir, "metric.json"),
      JSON.stringify({
        sp: { "1revenue": { source: "demo.public.revenue" } },
      }),
    );
    await expect(loadMetricRegistry(undefined, tmpDir)).rejects.toThrow();
  });
});

describe("AnalyticsPlugin — metric route handler", () => {
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

  test("returns 404 for an unregistered metric key", async () => {
    const plugin = new AnalyticsPlugin(config);
    const { router, getHandler } = createMockRouter();

    plugin.injectRoutes(router);

    const handler = getHandler("POST", "/metric/:key");
    const mockReq = createMockRequest({
      params: { key: "ghost" },
      body: { measures: ["arr"] },
    });
    const mockRes = createMockResponse();

    await handler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(404);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'Metric "ghost" not registered',
    });
  });

  test("returns 400 with the canonical error shape on validator failure", async () => {
    const plugin = new AnalyticsPlugin(config);
    plugin._setMetricRegistryForTesting({
      revenue: REVENUE_REGISTRATION,
    });
    const { router, getHandler } = createMockRouter();

    plugin.injectRoutes(router);

    const handler = getHandler("POST", "/metric/:key");
    const mockReq = createMockRequest({
      params: { key: "revenue" },
      body: { measures: ["bogus"] },
    });
    const mockRes = createMockResponse();

    await handler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(400);
    const errorPayload = (mockRes.json as any).mock.calls[0][0];
    expect(errorPayload.error).toMatch(/Invalid metric request body/);
    expect(errorPayload.code).toBe("VALIDATION_ERROR");
  });

  test("returns 400 when measures array is missing", async () => {
    const plugin = new AnalyticsPlugin(config);
    plugin._setMetricRegistryForTesting({
      revenue: REVENUE_REGISTRATION,
    });
    const { router, getHandler } = createMockRouter();

    plugin.injectRoutes(router);

    const handler = getHandler("POST", "/metric/:key");
    const mockReq = createMockRequest({
      params: { key: "revenue" },
      body: {},
    });
    const mockRes = createMockResponse();

    await handler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  test("executes a valid SP metric request and streams a result event", async () => {
    const plugin = new AnalyticsPlugin(config);
    plugin._setMetricRegistryForTesting({
      revenue: REVENUE_REGISTRATION,
    });
    const { router, getHandler } = createMockRouter();

    const executeMock = vi.fn().mockResolvedValue({
      result: { data: [{ arr: 1234567 }] },
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

    // Verify the constructed SQL hit the warehouse connector.
    expect(executeMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        statement:
          "SELECT MEASURE(arr) FROM appkit_demo.public.revenue_metrics",
        warehouse_id: "test-warehouse-id",
      }),
      expect.any(AbortSignal),
    );

    expect(mockRes.setHeader).toHaveBeenCalledWith(
      "Content-Type",
      "text/event-stream",
    );
    expect(mockRes.write).toHaveBeenCalledWith("event: result\n");
    expect(mockRes.write).toHaveBeenCalledWith(
      expect.stringContaining('"arr":1234567'),
    );
    expect(mockRes.end).toHaveBeenCalled();
  });

  test("hits the cache on the second identical SP request", async () => {
    const plugin = new AnalyticsPlugin(config);
    plugin._setMetricRegistryForTesting({
      revenue: REVENUE_REGISTRATION,
    });
    const { router, getHandler } = createMockRouter();

    const executeMock = vi.fn().mockResolvedValue({
      result: { data: [{ arr: 1234567 }] },
    });
    (plugin as any).SQLClient.executeStatement = executeMock;

    plugin.injectRoutes(router);

    const handler = getHandler("POST", "/metric/:key");

    const mockReq1 = createMockRequest({
      params: { key: "revenue" },
      body: { measures: ["arr"] },
    });
    const mockReq2 = createMockRequest({
      params: { key: "revenue" },
      body: { measures: ["arr"] },
    });

    await handler(mockReq1, createMockResponse());
    await handler(mockReq2, createMockResponse());

    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  // ── Phase 2: dimensions + time grain via the full route ───────────────
  test("constructs GROUP BY ALL SQL when dimensions are requested", async () => {
    const plugin = new AnalyticsPlugin(config);
    plugin._setMetricRegistryForTesting({
      revenue: REVENUE_REGISTRATION,
    });
    const { router, getHandler } = createMockRouter();

    const executeMock = vi.fn().mockResolvedValue({
      result: { data: [{ arr: 1, region: "EMEA" }] },
    });
    (plugin as any).SQLClient.executeStatement = executeMock;

    plugin.injectRoutes(router);

    const handler = getHandler("POST", "/metric/:key");
    const mockReq = createMockRequest({
      params: { key: "revenue" },
      body: { measures: ["arr"], dimensions: ["region"] },
    });
    const mockRes = createMockResponse();

    await handler(mockReq, mockRes);

    expect(executeMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        statement:
          "SELECT MEASURE(arr), region FROM appkit_demo.public.revenue_metrics GROUP BY ALL",
      }),
      expect.any(AbortSignal),
    );
  });

  test("constructs date_trunc SQL when timeGrain is set on a time-typed dim", async () => {
    const plugin = new AnalyticsPlugin(config);
    plugin._setMetricRegistryForTesting({
      revenue: REVENUE_REGISTRATION,
    });
    const { router, getHandler } = createMockRouter();

    const executeMock = vi.fn().mockResolvedValue({
      result: { data: [{ arr: 1, created_at: "2026-01-01" }] },
    });
    (plugin as any).SQLClient.executeStatement = executeMock;

    plugin.injectRoutes(router);

    const handler = getHandler("POST", "/metric/:key");
    const mockReq = createMockRequest({
      params: { key: "revenue" },
      body: {
        measures: ["arr"],
        dimensions: ["created_at"],
        timeGrain: "month",
      },
    });
    const mockRes = createMockResponse();

    await handler(mockReq, mockRes);

    expect(executeMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        statement:
          "SELECT MEASURE(arr), date_trunc('month', created_at) AS created_at FROM appkit_demo.public.revenue_metrics GROUP BY ALL",
      }),
      expect.any(AbortSignal),
    );
  });

  test("returns 400 when timeGrain is requested but no time-typed dim is grouped", async () => {
    const plugin = new AnalyticsPlugin(config);
    plugin._setMetricRegistryForTesting({
      revenue: REVENUE_REGISTRATION,
    });
    const { router, getHandler } = createMockRouter();

    plugin.injectRoutes(router);

    const handler = getHandler("POST", "/metric/:key");
    const mockReq = createMockRequest({
      params: { key: "revenue" },
      body: {
        measures: ["arr"],
        dimensions: ["region"],
        timeGrain: "month",
      },
    });
    const mockRes = createMockResponse();

    await handler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(400);
    const errorPayload = (mockRes.json as any).mock.calls[0][0];
    expect(errorPayload.error).toMatch(/no time-typed dimension/);
    expect(errorPayload.code).toBe("VALIDATION_ERROR");
  });

  test("returns 400 when an unknown dimension is requested", async () => {
    const plugin = new AnalyticsPlugin(config);
    plugin._setMetricRegistryForTesting({
      revenue: REVENUE_REGISTRATION,
    });
    const { router, getHandler } = createMockRouter();

    plugin.injectRoutes(router);

    const handler = getHandler("POST", "/metric/:key");
    const mockReq = createMockRequest({
      params: { key: "revenue" },
      body: { measures: ["arr"], dimensions: ["nonexistent"] },
    });
    const mockRes = createMockResponse();

    await handler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(400);
    const errorPayload = (mockRes.json as any).mock.calls[0][0];
    expect(errorPayload.code).toBe("VALIDATION_ERROR");
  });

  test("returns 400 when an unknown timeGrain is requested", async () => {
    const plugin = new AnalyticsPlugin(config);
    plugin._setMetricRegistryForTesting({
      revenue: REVENUE_REGISTRATION,
    });
    const { router, getHandler } = createMockRouter();

    plugin.injectRoutes(router);

    const handler = getHandler("POST", "/metric/:key");
    const mockReq = createMockRequest({
      params: { key: "revenue" },
      body: {
        measures: ["arr"],
        dimensions: ["created_at"],
        timeGrain: "year",
      },
    });
    const mockRes = createMockResponse();

    await handler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(400);
    const errorPayload = (mockRes.json as any).mock.calls[0][0];
    expect(errorPayload.code).toBe("VALIDATION_ERROR");
  });
});
