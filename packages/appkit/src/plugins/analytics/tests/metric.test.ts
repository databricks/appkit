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
  deriveMetricExecutorKey,
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

/**
 * Phase 3 fixture — adds a numeric dim (`deal_size`) and registered
 * `knownDimensionTypes` so op⇄type compatibility tests can exercise both
 * branches (range ops on numeric dim, string ops on string dim).
 */
const REVENUE_PHASE3_REGISTRATION: MetricRegistration = {
  ...REVENUE_REGISTRATION,
  knownDimensions: ["region", "segment", "created_at", "deal_size"],
  knownDimensionTypes: {
    region: "STRING",
    segment: "STRING",
    created_at: "TIMESTAMP",
    deal_size: "DOUBLE",
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
      ).toThrowError(/fields:.*measures/);
    });

    test("rejects a non-positive limit", () => {
      expect(() =>
        validateMetricRequest(REVENUE_REGISTRATION, {
          measures: ["arr"],
          limit: -1,
        }),
      ).toThrowError(/fields:.*limit/);
    });

    test("rejects limit exceeding the cap (unbounded-request-parameters)", () => {
      // Recurring pattern from prior reviews — caps prevent a hostile caller
      // from passing absurdly large `limit` values that would force the
      // warehouse to materialize unbounded result sets.
      expect(() =>
        validateMetricRequest(REVENUE_REGISTRATION, {
          measures: ["arr"],
          limit: 10_000_000,
        }),
      ).toThrowError(/fields:.*limit/);
    });

    test("rejects measures exceeding the cap", () => {
      const tooMany = Array.from({ length: 100 }, () => "arr");
      expect(() =>
        validateMetricRequest(REVENUE_REGISTRATION, { measures: tooMany }),
      ).toThrowError(/fields:.*measures/);
    });

    test("rejects a filter predicate with too many values (DoS guard)", () => {
      const big = Array.from({ length: 2000 }, (_, i) => `v${i}`);
      expect(() =>
        validateMetricRequest(REVENUE_REGISTRATION, {
          measures: ["arr"],
          filter: { member: "region", operator: "in", values: big },
        }),
      ).toThrowError(/fields:.*filter\.values/);
    });

    test("rejects unknown top-level fields (strict)", () => {
      expect(() =>
        validateMetricRequest(REVENUE_REGISTRATION, {
          measures: ["arr"],
          // 'someUnknownField' is not in the v1 contract and the strict()
          // schema must reject it. (filter is now a Phase 3 field.)
          someUnknownField: 123,
        } as any),
      ).toThrowError();
    });

    test("rejects filter passed as a bare array (not a Predicate or { and }/{or} group)", () => {
      expect(() =>
        validateMetricRequest(REVENUE_REGISTRATION, {
          measures: ["arr"],
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
      ).toThrowError(/fields:.*timeGrain/);
    });

    test("rejects timeGrain when no time-typed dim is in dimensions", () => {
      expect(() =>
        validateMetricRequest(REVENUE_REGISTRATION, {
          measures: ["arr"],
          dimensions: ["region"],
          timeGrain: "month",
        }),
      ).toThrowError(/fields:.*timeGrain/);
    });

    test("rejects timeGrain when dimensions is omitted entirely", () => {
      expect(() =>
        validateMetricRequest(REVENUE_REGISTRATION, {
          measures: ["arr"],
          timeGrain: "month",
        }),
      ).toThrowError(/fields:.*timeGrain/);
    });

    test("rejects timeGrain when metric has registered dims but none are time-typed", () => {
      // Tighter validation: when the registry knows the metric's dims but
      // none of them carry a time-grain set, `timeGrain` is meaningless on
      // this metric. Earlier this case fell open (validator skipped on empty
      // grainsByDim).
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
      ).toThrowError(/fields:.*timeGrain/);
    });

    test("rejects timeGrain when none of the requested dims are time-typed (metadata available)", () => {
      // Some dims are time-typed in the registry, but the request only
      // includes a non-time dim. The validator must catch the mismatch.
      const partialRegistration: MetricRegistration = {
        ...REVENUE_REGISTRATION,
        knownDimensions: ["region", "segment", "created_at"],
        knownTimeGrainsByDim: { created_at: ["day", "week", "month"] },
      };
      expect(() =>
        validateMetricRequest(partialRegistration, {
          measures: ["arr"],
          dimensions: ["region"],
          timeGrain: "month",
        }),
      ).toThrowError();
    });

    test("falls open on timeGrain when metadata is empty (no metrics.metadata.json)", () => {
      // Without build-time metadata the validator can't tell which dims are
      // time-typed. Mirror the dimensions-fall-open behavior: accept the
      // request and let the warehouse reject incompatible grains.
      const noMetadataRegistration: MetricRegistration = {
        ...REVENUE_REGISTRATION,
        knownDimensions: [],
        knownTimeGrainsByDim: {},
      };
      expect(() =>
        validateMetricRequest(noMetadataRegistration, {
          measures: ["arr"],
          dimensions: ["created_at"],
          timeGrain: "month",
        }),
      ).not.toThrowError();
    });
  });

  describe("buildMetricSql", () => {
    test("renders SELECT MEASURE(<m>) FROM <fqn>", () => {
      const { statement, parameters } = buildMetricSql(REVENUE_REGISTRATION, {
        measures: ["arr"],
      });
      expect(statement).toBe(
        "SELECT MEASURE(arr) AS arr FROM appkit_demo.public.revenue_metrics",
      );
      // No filter present → no bind params.
      expect(parameters).toEqual({});
    });

    test("sorts measures lexicographically for deterministic SQL", () => {
      const { statement } = buildMetricSql(REVENUE_REGISTRATION, {
        measures: ["mrr", "arr"],
      });
      expect(statement).toBe(
        "SELECT MEASURE(arr) AS arr, MEASURE(mrr) AS mrr FROM appkit_demo.public.revenue_metrics",
      );
    });

    test("appends LIMIT clause when limit is provided", () => {
      const { statement } = buildMetricSql(REVENUE_REGISTRATION, {
        measures: ["arr"],
        limit: 10,
      });
      expect(statement).toBe(
        "SELECT MEASURE(arr) AS arr FROM appkit_demo.public.revenue_metrics LIMIT 10",
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
        `"SELECT MEASURE(arr) AS arr FROM appkit_demo.public.revenue_metrics"`,
      );
    });

    test("emits dimensions + GROUP BY ALL (snapshot — dims-only)", () => {
      const { statement } = buildMetricSql(REVENUE_REGISTRATION, {
        measures: ["arr"],
        dimensions: ["region"],
      });
      expect(statement).toMatchInlineSnapshot(
        `"SELECT MEASURE(arr) AS arr, region FROM appkit_demo.public.revenue_metrics GROUP BY ALL"`,
      );
    });

    test("emits date_trunc for time-typed dim with timeGrain (snapshot — dims+time-grain)", () => {
      const { statement } = buildMetricSql(REVENUE_REGISTRATION, {
        measures: ["arr"],
        dimensions: ["created_at", "region"],
        timeGrain: "month",
      });
      expect(statement).toMatchInlineSnapshot(
        `"SELECT MEASURE(arr) AS arr, date_trunc('month', created_at) AS created_at, region FROM appkit_demo.public.revenue_metrics GROUP BY ALL"`,
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
        `"SELECT MEASURE(arr) AS arr, MEASURE(mrr) AS mrr, date_trunc('week', created_at) AS created_at FROM appkit_demo.public.revenue_metrics GROUP BY ALL LIMIT 50"`,
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
        "SELECT MEASURE(arr) AS arr, region, segment FROM appkit_demo.public.revenue_metrics GROUP BY ALL",
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

    test("filter values containing the `|` separator do not collide across distinct shapes", () => {
      // Regression: an earlier `String(v)` join used `|` as a separator,
      // making `["a", "b"]` collapse with `["a|string:b"]`. The fingerprint
      // must distinguish them so the SP cache cannot serve a different
      // user's results to a caller with a colliding-shaped filter.
      const a = composeMetricCacheKey({
        metricKey: "revenue",
        measures: ["arr"],
        filter: { member: "region", operator: "in", values: ["a", "b"] },
        format: "JSON",
        executorKey: "sp",
      });
      const b = composeMetricCacheKey({
        metricKey: "revenue",
        measures: ["arr"],
        filter: {
          member: "region",
          operator: "in",
          values: ["a|string:b"],
        },
        format: "JSON",
        executorKey: "sp",
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
    const errorPayload = (mockRes.json as any).mock.calls[0][0];
    expect(errorPayload.error).toBe("Metric not found");
    // Defense-in-depth: the public 404 must not echo the user-supplied key
    // back. Confirming "metric X is not registered" lets unauthenticated
    // probes enumerate registered keys by elimination.
    expect(errorPayload.error).not.toMatch(/ghost/);
  });

  test("returns 503 when the registered metric has no build-time metadata (fail-closed)", async () => {
    // Defense-in-depth: when `metrics.metadata.json` is missing or didn't
    // populate measures for this metric, the validator falls open and the
    // SQL constructor would let arbitrary identifiers through to the
    // warehouse — a schema-enumeration vector. Refuse the request.
    const plugin = new AnalyticsPlugin(config);
    plugin._setMetricRegistryForTesting({
      revenue: {
        ...REVENUE_REGISTRATION,
        knownMeasures: [],
        knownDimensions: [],
      },
    });
    const { router, getHandler } = createMockRouter();
    plugin.injectRoutes(router);

    const handler = getHandler("POST", "/metric/:key");
    const mockReq = createMockRequest({
      params: { key: "revenue" },
      body: { measures: ["arr"] },
    });
    const mockRes = createMockResponse();

    await handler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(503);
    const errorPayload = (mockRes.json as any).mock.calls[0][0];
    expect(errorPayload.code).toBe("METRIC_REGISTRY_NOT_READY");
    // Generic message — does not name the metric or the build-time tooling.
    expect(errorPayload.error).toBe("Metric registry not initialized");
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
          "SELECT MEASURE(arr) AS arr FROM appkit_demo.public.revenue_metrics",
        warehouse_id: "test-warehouse-id",
      }),
      expect.any(AbortSignal),
    );

    expect(mockRes.setHeader).toHaveBeenCalledWith(
      "Content-Type",
      expect.stringContaining("text/event-stream"),
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
          "SELECT MEASURE(arr) AS arr, region FROM appkit_demo.public.revenue_metrics GROUP BY ALL",
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
          "SELECT MEASURE(arr) AS arr, date_trunc('month', created_at) AS created_at FROM appkit_demo.public.revenue_metrics GROUP BY ALL",
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
    expect(errorPayload.error).toMatch(/fields:.*timeGrain/);
    expect(errorPayload.code).toBe("VALIDATION_ERROR");
    // Defense-in-depth: the public 400 must not enumerate the registered
    // schema (allowed grain enum, dim allowlist, etc.) — only the field path.
    expect(errorPayload.error).not.toMatch(/must be one of|no time-typed/);
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

// ============================================================================
// Phase 3 — Filter spec (recursive AND/OR with 12 v1 operators)
// ============================================================================

describe("metric — filter translator", () => {
  // Helper: render filter via buildMetricSql and return WHERE fragment + params.
  function render(
    filter: any,
    registration: MetricRegistration = REVENUE_PHASE3_REGISTRATION,
  ) {
    const { statement, parameters } = buildMetricSql(registration, {
      measures: ["arr"],
      filter,
    });
    // Pull just the WHERE portion (between ` WHERE ` and ` GROUP BY` / ` LIMIT` / end).
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

    test("gt → `<col> > :f_0`", () => {
      const { where, parameters } = render({
        member: "deal_size",
        operator: "gt",
        values: [10000],
      });
      expect(where).toBe("deal_size > :f_0");
      expect(parameters.f_0).toEqual({ __sql_type: "NUMERIC", value: "10000" });
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
      // Sort-before-hash: same member+operator pair sorts stably; both are
      // (region, equals). The OR fragment renders both predicates.
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
      // Outer is OR of (AND group, leaf predicate).
      expect(where).toMatch(/^\(.+ OR .+\)$/);
      expect(where).toContain(" AND ");
    });

    test("deeply nested mix of AND/OR (4 levels)", () => {
      const { where, parameters } = render({
        and: [
          {
            or: [
              {
                and: [
                  { member: "region", operator: "equals", values: ["EMEA"] },
                  {
                    or: [
                      {
                        member: "segment",
                        operator: "equals",
                        values: ["Enterprise"],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      });
      // Single-leaf groups collapse; multi-leaf groups parenthesize.
      expect(where).toBeTruthy();
      // All values are bound.
      expect(parameters.f_0.value).toBe("EMEA");
      expect(parameters.f_1.value).toBe("Enterprise");
    });

    test("empty AND/OR group emits no WHERE clause", () => {
      const { statement, parameters } = buildMetricSql(
        REVENUE_PHASE3_REGISTRATION,
        {
          measures: ["arr"],
          filter: { and: [] },
        },
      );
      expect(statement).not.toContain("WHERE");
      expect(parameters).toEqual({});
    });
  });

  describe("depth cap", () => {
    test("rejects 9 levels of AND nesting (validator)", () => {
      // Build 9-deep AND nesting: { and: [ { and: [ ... { equals } ] } ] }
      let node: any = {
        member: "region",
        operator: "equals",
        values: ["EMEA"],
      };
      for (let i = 0; i < 9; i += 1) {
        node = { and: [node] };
      }
      expect(() =>
        validateMetricRequest(REVENUE_PHASE3_REGISTRATION, {
          measures: ["arr"],
          filter: node,
        }),
      ).toThrowError(/fields:.*filter/);
    });

    test("accepts exactly 8 levels of AND nesting (validator)", () => {
      let node: any = {
        member: "region",
        operator: "equals",
        values: ["EMEA"],
      };
      for (let i = 0; i < 8; i += 1) {
        node = { and: [node] };
      }
      expect(() =>
        validateMetricRequest(REVENUE_PHASE3_REGISTRATION, {
          measures: ["arr"],
          filter: node,
        }),
      ).not.toThrow();
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
      // No raw value appears in the SQL string.
      expect(statement).not.toMatch(/region IN \([^:]/);
      expect(Object.keys(parameters)).toHaveLength(3);
    });

    test("identifier names in SQL come from the registry, not the request", () => {
      // Even if a hostile member somehow bypasses validation, the SQL
      // constructor's identifier guard rejects it before SQL emission.
      expect(() =>
        render({
          member: "region; DROP TABLE foo --",
          operator: "equals",
          values: ["x"],
        }),
      ).toThrowError(/not a valid identifier|unknown filter member/);
    });
  });

  describe("validator rejection cases", () => {
    test("rejects an unknown member", () => {
      expect(() =>
        validateMetricRequest(REVENUE_PHASE3_REGISTRATION, {
          measures: ["arr"],
          filter: {
            member: "ghost",
            operator: "equals",
            values: ["x"],
          },
        }),
      ).toThrowError(/fields:.*filter\.member/);
    });

    test("rejects an unknown operator", () => {
      expect(() =>
        validateMetricRequest(REVENUE_PHASE3_REGISTRATION, {
          measures: ["arr"],
          filter: {
            member: "region",
            operator: "startsWith" as any,
            values: ["E"],
          },
        }),
      ).toThrowError(/fields:.*filter\.operator/);
    });

    test("rejects gt on a string-typed dimension (op⇄type)", () => {
      expect(() =>
        validateMetricRequest(REVENUE_PHASE3_REGISTRATION, {
          measures: ["arr"],
          filter: {
            member: "region",
            operator: "gt",
            values: ["EMEA"],
          },
        }),
      ).toThrowError(/fields:.*filter\.operator/);
    });

    test("rejects contains on a numeric-typed dimension (op⇄type)", () => {
      expect(() =>
        validateMetricRequest(REVENUE_PHASE3_REGISTRATION, {
          measures: ["arr"],
          filter: {
            member: "deal_size",
            operator: "contains",
            values: ["1000"],
          },
        }),
      ).toThrowError(/fields:.*filter\.operator/);
    });

    test("rejects contains on a date-typed dimension (op⇄type)", () => {
      expect(() =>
        validateMetricRequest(REVENUE_PHASE3_REGISTRATION, {
          measures: ["arr"],
          filter: {
            member: "created_at",
            operator: "contains",
            values: ["2026"],
          },
        }),
      ).toThrowError(/fields:.*filter\.operator/);
    });

    test("accepts gt on a date-typed dimension", () => {
      expect(() =>
        validateMetricRequest(REVENUE_PHASE3_REGISTRATION, {
          measures: ["arr"],
          filter: {
            member: "created_at",
            operator: "gt",
            values: ["2026-01-01"],
          },
        }),
      ).not.toThrow();
    });

    test("rejects equals with zero values (cardinality)", () => {
      expect(() =>
        validateMetricRequest(REVENUE_PHASE3_REGISTRATION, {
          measures: ["arr"],
          filter: {
            member: "region",
            operator: "equals",
            values: [],
          },
        }),
      ).toThrowError(/fields:.*filter\.values/);
    });

    test("rejects equals with multiple values (cardinality)", () => {
      expect(() =>
        validateMetricRequest(REVENUE_PHASE3_REGISTRATION, {
          measures: ["arr"],
          filter: {
            member: "region",
            operator: "equals",
            values: ["A", "B"],
          },
        }),
      ).toThrowError(/fields:.*filter\.values/);
    });

    test("rejects in with empty values (cardinality)", () => {
      expect(() =>
        validateMetricRequest(REVENUE_PHASE3_REGISTRATION, {
          measures: ["arr"],
          filter: {
            member: "region",
            operator: "in",
            values: [],
          },
        }),
      ).toThrowError(/fields:.*filter\.values/);
    });

    test("rejects set with values (cardinality — must be absent)", () => {
      expect(() =>
        validateMetricRequest(REVENUE_PHASE3_REGISTRATION, {
          measures: ["arr"],
          filter: {
            member: "region",
            operator: "set",
            values: ["EMEA"],
          },
        }),
      ).toThrowError(/fields:.*filter\.values/);
    });

    test("accepts set with no values", () => {
      expect(() =>
        validateMetricRequest(REVENUE_PHASE3_REGISTRATION, {
          measures: ["arr"],
          filter: {
            member: "region",
            operator: "set",
          },
        }),
      ).not.toThrow();
    });

    test("accepts notSet with empty values array", () => {
      expect(() =>
        validateMetricRequest(REVENUE_PHASE3_REGISTRATION, {
          measures: ["arr"],
          filter: {
            member: "region",
            operator: "notSet",
            values: [],
          },
        }),
      ).not.toThrow();
    });

    test("falls open on op⇄type when registry has no type metadata", () => {
      // Without knownDimensionTypes, the validator cannot enforce op⇄type
      // and accepts any op on any registered dim (defense-in-depth — the
      // SQL constructor still enforces identifier shape and registry
      // membership).
      expect(() =>
        validateMetricRequest(REVENUE_REGISTRATION, {
          measures: ["arr"],
          filter: {
            member: "region",
            operator: "gt",
            values: ["EMEA"],
          },
        }),
      ).not.toThrow();
    });

    test("rejects empty `or` group (empty disjunction is vacuously false)", () => {
      // Empty AND is vacuously true (no constraint). Empty OR would be
      // vacuously false — silently dropping the predicate. Force the caller
      // to omit the predicate entirely so intent stays explicit.
      expect(() =>
        validateMetricRequest(REVENUE_PHASE3_REGISTRATION, {
          measures: ["arr"],
          filter: { or: [] },
        }),
      ).toThrowError(/fields:.*filter\.or/);
    });

    test("accepts empty `and` group (no constraint contributed)", () => {
      // Empty AND is the validator's "do not contribute" shape — accepted.
      expect(() =>
        validateMetricRequest(REVENUE_PHASE3_REGISTRATION, {
          measures: ["arr"],
          filter: { and: [] },
        }),
      ).not.toThrow();
    });

    test("rejects `contains` with a non-string value", () => {
      expect(() =>
        validateMetricRequest(REVENUE_PHASE3_REGISTRATION, {
          measures: ["arr"],
          filter: {
            member: "region",
            operator: "contains",
            values: [42 as unknown as string],
          },
        }),
      ).toThrowError(/fields:.*filter\.values/);
    });

    test("rejects range op with a non-numeric value on a numeric dim", () => {
      expect(() =>
        validateMetricRequest(REVENUE_PHASE3_REGISTRATION, {
          measures: ["arr"],
          filter: {
            member: "deal_size",
            operator: "gt",
            values: ["large" as unknown as number],
          },
        }),
      ).toThrowError(/fields:.*filter\.values/);
    });

    test("rejects member at depth — nested filter with unknown member", () => {
      expect(() =>
        validateMetricRequest(REVENUE_PHASE3_REGISTRATION, {
          measures: ["arr"],
          filter: {
            and: [
              { member: "region", operator: "equals", values: ["EMEA"] },
              { member: "ghost", operator: "equals", values: ["X"] },
            ],
          },
        }),
      ).toThrowError(/fields:.*filter\.and\.1\.member/);
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
      // The bind-var indices may differ but the textual fragment shape
      // sorts predicates by (member, operator), so both calls render the
      // same WHERE clause.
      expect(a.where).toBe(b.where);
    });

    test("predicate order does not affect cache key", () => {
      const a = composeMetricCacheKey({
        metricKey: "revenue",
        measures: ["arr"],
        format: "JSON",
        executorKey: "sp",
        filter: {
          and: [
            { member: "region", operator: "equals", values: ["EMEA"] },
            { member: "segment", operator: "equals", values: ["Ent"] },
          ],
        },
      });
      const b = composeMetricCacheKey({
        metricKey: "revenue",
        measures: ["arr"],
        format: "JSON",
        executorKey: "sp",
        filter: {
          and: [
            { member: "segment", operator: "equals", values: ["Ent"] },
            { member: "region", operator: "equals", values: ["EMEA"] },
          ],
        },
      });
      expect(a).toEqual(b);
    });

    test("differentiates filtered vs unfiltered cache keys", () => {
      const filtered = composeMetricCacheKey({
        metricKey: "revenue",
        measures: ["arr"],
        format: "JSON",
        executorKey: "sp",
        filter: {
          member: "region",
          operator: "equals",
          values: ["EMEA"],
        },
      });
      const unfiltered = composeMetricCacheKey({
        metricKey: "revenue",
        measures: ["arr"],
        format: "JSON",
        executorKey: "sp",
      });
      expect(filtered).not.toEqual(unfiltered);
    });

    test("differentiates filters with different values", () => {
      const a = composeMetricCacheKey({
        metricKey: "revenue",
        measures: ["arr"],
        format: "JSON",
        executorKey: "sp",
        filter: {
          member: "region",
          operator: "equals",
          values: ["EMEA"],
        },
      });
      const b = composeMetricCacheKey({
        metricKey: "revenue",
        measures: ["arr"],
        format: "JSON",
        executorKey: "sp",
        filter: {
          member: "region",
          operator: "equals",
          values: ["APAC"],
        },
      });
      expect(a).not.toEqual(b);
    });
  });

  describe("route handler — filter integration", () => {
    let serviceContextMock: Awaited<ReturnType<typeof mockServiceContext>>;
    beforeEach(async () => {
      setupDatabricksEnv();
      mockCacheStore.clear();
      ServiceContext.reset();
      serviceContextMock = await mockServiceContext();
    });
    afterEach(() => {
      serviceContextMock?.restore();
    });

    test("constructs WHERE clause from a structured filter", async () => {
      const plugin = new AnalyticsPlugin({ timeout: 5000 });
      plugin._setMetricRegistryForTesting({
        revenue: REVENUE_PHASE3_REGISTRATION,
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
        body: {
          measures: ["arr"],
          filter: {
            member: "region",
            operator: "in",
            values: ["EMEA", "APAC"],
          },
        },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(executeMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          statement: expect.stringContaining("WHERE region IN (:f_0, :f_1)"),
          parameters: expect.arrayContaining([
            expect.objectContaining({
              name: "f_0",
              value: "EMEA",
              type: "STRING",
            }),
            expect.objectContaining({
              name: "f_1",
              value: "APAC",
              type: "STRING",
            }),
          ]),
        }),
        expect.any(AbortSignal),
      );
    });

    test("returns 400 with the canonical error shape on filter rejection", async () => {
      const plugin = new AnalyticsPlugin({ timeout: 5000 });
      plugin._setMetricRegistryForTesting({
        revenue: REVENUE_PHASE3_REGISTRATION,
      });
      const { router, getHandler } = createMockRouter();
      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/metric/:key");
      const mockReq = createMockRequest({
        params: { key: "revenue" },
        body: {
          measures: ["arr"],
          filter: {
            member: "ghost",
            operator: "equals",
            values: ["X"],
          },
        },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      const errorPayload = (mockRes.json as any).mock.calls[0][0];
      expect(errorPayload.code).toBe("VALIDATION_ERROR");
      expect(errorPayload.error).toMatch(/fields:.*filter\.member/);
      // Defense-in-depth: the public 400 must not name the registry's
      // allowed dimensions. The full Zod issues stay in telemetry context.
      expect(errorPayload.error).not.toMatch(
        /not a declared dimension|allowed:|must be one of/,
      );
    });
  });
});

// ============================================================================
// Phase 4 — OBO lane + cache key composition (final form)
//
// Activates the OBO execution lane and finalizes cache-key composition. The
// cache executor key for OBO entries is a sha256 hash of the user identity —
// the raw header value never reaches the cache layer (privacy). Cross-user
// isolation, cross-lane isolation, and sort-before-hash on measures and
// dimensions are exercised here.
// ============================================================================

const CUSTOMER_OBO_REGISTRATION: MetricRegistration = {
  key: "customer_metrics",
  source: "appkit_demo.public.customer_metrics",
  lane: "obo",
  knownMeasures: ["churn_rate", "arpu"],
  knownDimensions: ["csm_email", "region"],
  knownTimeGrainsByDim: {},
};

describe("metric — Phase 4 cache executor key", () => {
  describe("deriveMetricExecutorKey", () => {
    test("returns the literal 'sp' for SP-lane entries", () => {
      const key = deriveMetricExecutorKey({ lane: "sp" });
      expect(key).toBe("sp");
    });

    test("ignores userIdentity for SP-lane entries (caller cannot escalate)", () => {
      // Even if a caller passes a userIdentity for an SP-lane entry, the
      // function must return "sp" — SP-lane caches are inherently shared.
      const key = deriveMetricExecutorKey({
        lane: "sp",
        userIdentity: "alice@example.com",
      });
      expect(key).toBe("sp");
    });

    test("returns a sha256 hex digest for OBO-lane entries", () => {
      const key = deriveMetricExecutorKey({
        lane: "obo",
        userIdentity: "alice@example.com",
      });
      // sha256 hex digest is 64 chars long.
      expect(key).toMatch(/^[0-9a-f]{64}$/);
    });

    test("OBO digest is stable across calls for the same identity", () => {
      const a = deriveMetricExecutorKey({
        lane: "obo",
        userIdentity: "alice@example.com",
      });
      const b = deriveMetricExecutorKey({
        lane: "obo",
        userIdentity: "alice@example.com",
      });
      expect(a).toBe(b);
    });

    test("OBO digests differ for different identities", () => {
      const alice = deriveMetricExecutorKey({
        lane: "obo",
        userIdentity: "alice@example.com",
      });
      const bob = deriveMetricExecutorKey({
        lane: "obo",
        userIdentity: "bob@example.com",
      });
      expect(alice).not.toBe(bob);
    });

    test("does not contain the raw user identity (privacy)", () => {
      // The hash output must not include the raw email — the whole point of
      // hashing is that the cache layer (which logs keys) never sees PII.
      const identity = "alice@example.com";
      const key = deriveMetricExecutorKey({
        lane: "obo",
        userIdentity: identity,
      });
      expect(key).not.toContain(identity);
      expect(key).not.toContain("alice");
      expect(key).not.toContain("@");
    });

    test("OBO-lane null identity falls back to anonymous sentinel", () => {
      const a = deriveMetricExecutorKey({ lane: "obo", userIdentity: null });
      const b = deriveMetricExecutorKey({
        lane: "obo",
        userIdentity: undefined,
      });
      const c = deriveMetricExecutorKey({ lane: "obo", userIdentity: "" });
      const d = deriveMetricExecutorKey({ lane: "obo", userIdentity: "   " });
      // All map to the same sentinel hash.
      expect(a).toBe(b);
      expect(b).toBe(c);
      expect(c).toBe(d);
      expect(a).toMatch(/^[0-9a-f]{64}$/);
    });

    test("OBO sentinel hash differs from any real identity hash", () => {
      const sentinel = deriveMetricExecutorKey({
        lane: "obo",
        userIdentity: undefined,
      });
      const realUser = deriveMetricExecutorKey({
        lane: "obo",
        userIdentity: "alice@example.com",
      });
      expect(sentinel).not.toBe(realUser);
    });

    test("SP key differs from any OBO key (cross-lane isolation)", () => {
      const sp = deriveMetricExecutorKey({ lane: "sp" });
      const obo = deriveMetricExecutorKey({
        lane: "obo",
        userIdentity: "alice@example.com",
      });
      expect(sp).not.toBe(obo);
    });
  });

  describe("composeMetricCacheKey — Phase 4 invariants", () => {
    test("same args, different measure order → same key", () => {
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

    test("same args, different dimension order → same key", () => {
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

    test("same args, different filter predicate order → same key", () => {
      const a = composeMetricCacheKey({
        metricKey: "revenue",
        measures: ["arr"],
        format: "JSON",
        executorKey: "sp",
        filter: {
          and: [
            { member: "region", operator: "equals", values: ["EMEA"] },
            { member: "segment", operator: "equals", values: ["Ent"] },
          ],
        },
      });
      const b = composeMetricCacheKey({
        metricKey: "revenue",
        measures: ["arr"],
        format: "JSON",
        executorKey: "sp",
        filter: {
          and: [
            { member: "segment", operator: "equals", values: ["Ent"] },
            { member: "region", operator: "equals", values: ["EMEA"] },
          ],
        },
      });
      expect(a).toEqual(b);
    });

    test("different args → different key", () => {
      const a = composeMetricCacheKey({
        metricKey: "revenue",
        measures: ["arr"],
        format: "JSON",
        executorKey: "sp",
      });
      const b = composeMetricCacheKey({
        metricKey: "revenue",
        measures: ["mrr"],
        format: "JSON",
        executorKey: "sp",
      });
      expect(a).not.toEqual(b);
    });

    test("SP vs OBO same args → different keys (cross-lane isolation)", () => {
      const sp = composeMetricCacheKey({
        metricKey: "revenue",
        measures: ["arr"],
        format: "JSON",
        executorKey: deriveMetricExecutorKey({ lane: "sp" }),
      });
      const obo = composeMetricCacheKey({
        metricKey: "revenue",
        measures: ["arr"],
        format: "JSON",
        executorKey: deriveMetricExecutorKey({
          lane: "obo",
          userIdentity: "alice@example.com",
        }),
      });
      expect(sp).not.toEqual(obo);
    });

    test("OBO different users → different keys (cross-user isolation)", () => {
      const alice = composeMetricCacheKey({
        metricKey: "customer_metrics",
        measures: ["churn_rate"],
        format: "JSON",
        executorKey: deriveMetricExecutorKey({
          lane: "obo",
          userIdentity: "alice@example.com",
        }),
      });
      const bob = composeMetricCacheKey({
        metricKey: "customer_metrics",
        measures: ["churn_rate"],
        format: "JSON",
        executorKey: deriveMetricExecutorKey({
          lane: "obo",
          userIdentity: "bob@example.com",
        }),
      });
      expect(alice).not.toEqual(bob);
    });

    test("OBO same user, same args → same key (cache hit)", () => {
      const a = composeMetricCacheKey({
        metricKey: "customer_metrics",
        measures: ["churn_rate"],
        format: "JSON",
        executorKey: deriveMetricExecutorKey({
          lane: "obo",
          userIdentity: "alice@example.com",
        }),
      });
      const b = composeMetricCacheKey({
        metricKey: "customer_metrics",
        measures: ["churn_rate"],
        format: "JSON",
        executorKey: deriveMetricExecutorKey({
          lane: "obo",
          userIdentity: "alice@example.com",
        }),
      });
      expect(a).toEqual(b);
    });

    test("the raw user identity is not present in the cache key (privacy)", () => {
      const identity = "alice@example.com";
      const key = composeMetricCacheKey({
        metricKey: "customer_metrics",
        measures: ["churn_rate"],
        format: "JSON",
        executorKey: deriveMetricExecutorKey({
          lane: "obo",
          userIdentity: identity,
        }),
      });
      // Inspect every part — none should contain the raw identity.
      for (const part of key) {
        expect(part).not.toContain(identity);
        expect(part).not.toContain("alice");
        expect(part).not.toContain("@example.com");
      }
    });
  });
});

describe("AnalyticsPlugin — Phase 4 OBO + cache executor key", () => {
  let serviceContextMock: Awaited<ReturnType<typeof mockServiceContext>>;

  beforeEach(async () => {
    setupDatabricksEnv();
    mockCacheStore.clear();
    ServiceContext.reset();
    serviceContextMock = await mockServiceContext();
  });

  afterEach(() => {
    serviceContextMock?.restore();
  });

  test("OBO lane: same args, different mock users → both queries execute (no cache leak)", async () => {
    const plugin = new AnalyticsPlugin({ timeout: 5000 });
    plugin._setMetricRegistryForTesting({
      customer_metrics: CUSTOMER_OBO_REGISTRATION,
    });
    const { router, getHandler } = createMockRouter();

    const executeMock = vi
      .fn()
      .mockResolvedValueOnce({
        result: { data: [{ csm_email: "alice@x.com", churn_rate: 0.1 }] },
      })
      .mockResolvedValueOnce({
        result: { data: [{ csm_email: "bob@x.com", churn_rate: 0.2 }] },
      });
    (plugin as any).SQLClient.executeStatement = executeMock;

    plugin.injectRoutes(router);

    const handler = getHandler("POST", "/metric/:key");

    const aliceReq = createMockRequest({
      params: { key: "customer_metrics" },
      body: { measures: ["churn_rate"] },
      headers: {
        "x-forwarded-access-token": "alice-token",
        "x-forwarded-user": "alice@example.com",
      },
    });
    const aliceRes = createMockResponse();
    await handler(aliceReq, aliceRes);

    const bobReq = createMockRequest({
      params: { key: "customer_metrics" },
      body: { measures: ["churn_rate"] },
      headers: {
        "x-forwarded-access-token": "bob-token",
        "x-forwarded-user": "bob@example.com",
      },
    });
    const bobRes = createMockResponse();
    await handler(bobReq, bobRes);

    // Different users, same query — the OBO cache must be partitioned per
    // user, so both calls hit the warehouse.
    expect(executeMock).toHaveBeenCalledTimes(2);

    // Each user sees their own row (no cache cross-contamination).
    expect(aliceRes.write).toHaveBeenCalledWith(
      expect.stringContaining("alice@x.com"),
    );
    expect(bobRes.write).toHaveBeenCalledWith(
      expect.stringContaining("bob@x.com"),
    );
  });

  test("OBO lane: same user, same args twice → second request hits cache", async () => {
    const plugin = new AnalyticsPlugin({ timeout: 5000 });
    plugin._setMetricRegistryForTesting({
      customer_metrics: CUSTOMER_OBO_REGISTRATION,
    });
    const { router, getHandler } = createMockRouter();

    const executeMock = vi.fn().mockResolvedValue({
      result: { data: [{ csm_email: "alice@x.com", churn_rate: 0.1 }] },
    });
    (plugin as any).SQLClient.executeStatement = executeMock;

    plugin.injectRoutes(router);

    const handler = getHandler("POST", "/metric/:key");

    const makeReq = () =>
      createMockRequest({
        params: { key: "customer_metrics" },
        body: { measures: ["churn_rate"] },
        headers: {
          "x-forwarded-access-token": "alice-token",
          "x-forwarded-user": "alice@example.com",
        },
      });

    await handler(makeReq(), createMockResponse());
    await handler(makeReq(), createMockResponse());

    // Second request is served from cache.
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  test("cross-lane isolation: SP user 'sp' literal does not collide with an OBO user named 'sp'", async () => {
    // Defense-in-depth — the executor-key derivation must not let a user
    // identity collide with the literal "sp" cache scope. Hashing the
    // identity ensures this collision is structurally impossible.
    const sp = deriveMetricExecutorKey({ lane: "sp" });
    const obo = deriveMetricExecutorKey({
      lane: "obo",
      userIdentity: "sp",
    });
    expect(sp).not.toBe(obo);
  });

  test("cache TTL defaults to 1 hour (3600 seconds) — matches existing analytics", async () => {
    // The route handler builds its `defaultConfig` from `queryDefaults` —
    // assert the TTL is unchanged so a future refactor that swaps defaults
    // is caught by this test.
    const { queryDefaults } = await import("../defaults");
    expect(queryDefaults.cache?.ttl).toBe(3600);
  });

  test("metric.json registry rejects same key in both sp and obo lanes (cross-lane key uniqueness)", async () => {
    // Acceptance criterion 7: a metric key registered in both `sp` and
    // `obo` is rejected at config-load time. Re-exercise the existing
    // loader test here under the Phase 4 banner so the requirement is
    // discoverable when reading Phase 4 tests.
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "appkit-metric-phase4-"),
    );
    try {
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
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
