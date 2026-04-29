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
  knownDimensions: ["region", "segment"],
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
          dimensions: ["region"], // not allowed at v1
        }),
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
});
