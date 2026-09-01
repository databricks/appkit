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
import type { MetricViewsMetadata } from "shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { AppManager } from "../../../app";
import { ServiceContext } from "../../../context/service-context";
import { AuthenticationError } from "../../../errors";
import { AnalyticsPlugin } from "../analytics";
import {
  buildMetricSql,
  composeMetricCacheKey,
  deriveMetricExecutorKey,
  loadMetricMetadata,
  loadMetricRegistry,
  selectMetricMetadata,
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

// Temp dirs created by `registryDir` / `writeRegistry`, cleaned up after each
// test. Using real files (pointing the plugin's `AppManager` at the dir, see
// `pluginForDir`) exercises the actual read → parse path in
// `loadMetricRegistry` rather than poking private plugin state.
const tempRegistryDirs: string[] = [];

/**
 * Construct an `AnalyticsPlugin` whose metric-registry gateway is pointed at
 * `dir` (treated as the metric-views config directory).
 *
 * The plugin reads the registry through the base `Plugin`'s shared `this.app`
 * (an `AppManager`; the metric path reads from its `metricViewsDir`,
 * `config/metric-views/` under the cwd). There is no config field to relocate
 * that directory, so a test points the plugin at a fixture dir by overriding
 * the `AppManager` with one whose metric-views dir IS `dir` (the first arg — a
 * sibling queries dir — is unused by the metric path). `app` is `protected` on
 * the base `Plugin`, hence the deliberate test-only cast — the single seam
 * every route-handler test threads through.
 */
function pluginForDir(config: IAnalyticsConfig, dir: string): AnalyticsPlugin {
  const plugin = new AnalyticsPlugin(config);
  (plugin as any).app = new AppManager(path.join(dir, "queries"), dir);
  return plugin;
}

/**
 * Write a `definitions.json` into a fresh temp dir and return the dir, for use
 * with `pluginForDir(config, dir)`. Accepts the internal `MetricRegistration`
 * shape (matching the old `setRegistry` helper) and maps each entry's `lane`
 * back to the config's `executor` field.
 */
function registryDir(registry: Record<string, MetricRegistration>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "mv-route-"));
  tempRegistryDirs.push(dir);
  const metricViews: Record<string, { source: string; executor: string }> = {};
  for (const [key, reg] of Object.entries(registry)) {
    metricViews[key] = {
      source: reg.source,
      executor: reg.lane === "obo" ? "user" : "app_service_principal",
    };
  }
  writeFileSync(
    path.join(dir, "definitions.json"),
    JSON.stringify({ metricViews }),
  );
  return dir;
}

/**
 * Overwrite the `definitions.json` in an existing temp dir (for hot-reload /
 * self-heal tests). `raw` lets a test write deliberately malformed content.
 */
function writeRegistry(
  dir: string,
  content: Record<string, MetricRegistration> | string,
): void {
  const body =
    typeof content === "string"
      ? content
      : JSON.stringify({
          metricViews: Object.fromEntries(
            Object.entries(content).map(([key, reg]) => [
              key,
              {
                source: reg.source,
                executor: reg.lane === "obo" ? "user" : "app_service_principal",
              },
            ]),
          ),
        });
  writeFileSync(path.join(dir, "definitions.json"), body);
}

describe("analytics metric route", () => {
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
    while (tempRegistryDirs.length > 0) {
      const dir = tempRegistryDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
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

  // ── Identifier safety — the primary security test. Measure/dimension names
  // are backtick-quoted (not narrow-gated) at interpolation, so an injection-
  // shaped name is NEUTRALIZED by quoting rather than rejected: it becomes an
  // inert (if nonexistent) column the warehouse resolves away. Only a name
  // that cannot be safely quoted at all — one containing a control character
  // or newline — is refused.
  describe("buildMetricSql identifier safety (quoting)", () => {
    const registration: MetricRegistration = {
      key: "revenue",
      source: "cat.sch.revenue_metrics",
      lane: "sp",
    };

    test("neutralizes an injection-shaped measure by quoting (no breakout)", () => {
      // `arr; DROP TABLE users` has no control chars, so it is a valid (if
      // nonexistent) column name: quoted whole, the `;` and `DROP` are inert
      // inside the backtick-delimited identifier — not separate statements.
      const { statement } = buildMetricSql(registration, {
        measures: ["arr; DROP TABLE users"],
      });
      expect(statement).toBe(
        "SELECT MEASURE(`arr; DROP TABLE users`) AS `arr; DROP TABLE users` FROM `cat`.`sch`.`revenue_metrics`",
      );
    });

    test("neutralizes a backtick in a measure by doubling it", () => {
      // The one real breakout char is the backtick; quoteIdentifier doubles it
      // so it cannot close the identifier early.
      const { statement } = buildMetricSql(registration, {
        measures: ["arr`"],
      });
      expect(statement).toBe(
        "SELECT MEASURE(`arr```) AS `arr``` FROM `cat`.`sch`.`revenue_metrics`",
      );
    });

    test("throws for a measure containing a control character (cannot be quoted)", () => {
      expect(() =>
        buildMetricSql(registration, { measures: ["arr\ndrop"] }),
      ).toThrow(/not a valid identifier|control character/);
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

    test("accepts a hyphenated UC-legal FQN and backtick-quotes it", () => {
      // Regression for the grammar divergence: `prod-data` is a legal UC
      // object name (hyphens are allowed in quoted identifiers) and passes the
      // shared schema + typegen, but the old narrow runtime pattern
      // [a-zA-Z0-9_-] anchored per segment REJECTED it — a latent prod break on
      // a documented-legal name. The builder now accepts it and quotes every
      // segment, so it reaches the warehouse as valid SQL rather than throwing.
      const { statement } = buildMetricSql(
        { key: "x", source: "prod-data.analytics.revenue", lane: "sp" },
        { measures: ["arr"] },
      );
      expect(statement).toBe(
        "SELECT MEASURE(`arr`) AS `arr` FROM `prod-data`.`analytics`.`revenue`",
      );
    });

    test("backtick-quoting neutralizes an injection-shaped FQN segment", () => {
      // A source carrying a backtick would break out of the quoted identifier
      // if interpolated raw; quoteFqnForSql doubles it. (isValidFqn rejects
      // most such names first, but the quoting is the actual injection
      // boundary — this asserts it, not just the grammar gate.)
      const { statement } = buildMetricSql(
        { key: "x", source: "cat.sch.re`v", lane: "sp" },
        { measures: ["arr"] },
      );
      expect(statement).toBe(
        "SELECT MEASURE(`arr`) AS `arr` FROM `cat`.`sch`.`re``v`",
      );
    });
  });

  // ── Measures-only SQL shape.
  describe("buildMetricSql SQL shape", () => {
    const registration: MetricRegistration = {
      key: "revenue",
      source: "cat.sch.revenue_metrics",
      lane: "sp",
    };

    test("single measure → SELECT MEASURE(`m`) AS `m` FROM <fqn>", () => {
      const { statement, parameters } = buildMetricSql(registration, {
        measures: ["arr"],
      });
      expect(statement).toBe(
        "SELECT MEASURE(`arr`) AS `arr` FROM `cat`.`sch`.`revenue_metrics`",
      );
      expect(parameters).toEqual({});
    });

    test("multiple measures are sorted for a deterministic SELECT list", () => {
      const { statement } = buildMetricSql(registration, {
        measures: ["revenue", "arr"],
      });
      expect(statement).toBe(
        "SELECT MEASURE(`arr`) AS `arr`, MEASURE(`revenue`) AS `revenue` FROM `cat`.`sch`.`revenue_metrics`",
      );
    });

    test("positive limit appends a floored LIMIT clause", () => {
      const { statement } = buildMetricSql(registration, {
        measures: ["arr"],
        limit: 10.9,
      });
      expect(statement).toBe(
        "SELECT MEASURE(`arr`) AS `arr` FROM `cat`.`sch`.`revenue_metrics` LIMIT 10",
      );
    });
  });

  // ── dimensions + GROUP BY ALL. Bare dimensions here; date_trunc grain
  // application (via timeDimension) is covered in its own block below.
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
        "SELECT MEASURE(`arr`) AS `arr`, `region` FROM `cat`.`sch`.`revenue_metrics` GROUP BY ALL",
      );
    });

    test("dimensions are sorted for a deterministic SELECT list", () => {
      const { statement } = buildMetricSql(registration, {
        measures: ["arr"],
        dimensions: ["segment", "region"],
      });
      expect(statement).toBe(
        "SELECT MEASURE(`arr`) AS `arr`, `region`, `segment` FROM `cat`.`sch`.`revenue_metrics` GROUP BY ALL",
      );
    });

    test("measures sort before dimensions in the SELECT list", () => {
      const { statement } = buildMetricSql(registration, {
        measures: ["revenue", "arr"],
        dimensions: ["region"],
      });
      expect(statement).toBe(
        "SELECT MEASURE(`arr`) AS `arr`, MEASURE(`revenue`) AS `revenue`, `region` FROM `cat`.`sch`.`revenue_metrics` GROUP BY ALL",
      );
    });

    test("empty dimensions array → no GROUP BY (ungrouped)", () => {
      const { statement } = buildMetricSql(registration, {
        measures: ["arr"],
        dimensions: [],
      });
      expect(statement).toBe(
        "SELECT MEASURE(`arr`) AS `arr` FROM `cat`.`sch`.`revenue_metrics`",
      );
    });

    test("dimensions + limit compose GROUP BY ALL then ORDER BY (deterministic) then LIMIT", () => {
      const { statement } = buildMetricSql(registration, {
        measures: ["arr"],
        dimensions: ["region"],
        limit: 100,
      });
      expect(statement).toBe(
        "SELECT MEASURE(`arr`) AS `arr`, `region` FROM `cat`.`sch`.`revenue_metrics` GROUP BY ALL ORDER BY `region` LIMIT 100",
      );
    });

    test("no timeGrain → all dimensions render bare (no date_trunc)", () => {
      const { statement } = buildMetricSql(registration, {
        measures: ["arr"],
        dimensions: ["order_date", "region"],
      });
      expect(statement).toBe(
        "SELECT MEASURE(`arr`) AS `arr`, `order_date`, `region` FROM `cat`.`sch`.`revenue_metrics` GROUP BY ALL",
      );
      expect(statement).not.toContain("date_trunc");
    });
  });

  // ── timeGrain + timeDimension → date_trunc on the named column.
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
        "SELECT MEASURE(`arr`) AS `arr`, date_trunc('month', `order_date`) AS `order_date`, `region` FROM `cat`.`sch`.`revenue_metrics` GROUP BY ALL",
      );
      expect(statement).toContain(
        "date_trunc('month', `order_date`) AS `order_date`",
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
        "SELECT MEASURE(`arr`) AS `arr`, date_trunc('day', `order_date`) AS `order_date` FROM `cat`.`sch`.`revenue_metrics` GROUP BY ALL",
      );
    });

    test("a grammar-invalid timeGrain throws in the builder (defense-in-depth, even if validation is bypassed)", () => {
      // buildMetricSql is exported and may be reached on a path that skips
      // validateMetricRequest, so the grain — interpolated into a single-quoted
      // date_trunc literal — is re-gated at the interpolation point. A quote-
      // breakout payload must be refused by the builder itself.
      expect(() =>
        buildMetricSql(registration, {
          measures: ["arr"],
          dimensions: ["order_date"],
          timeGrain: "month'); DROP TABLE t;--",
          timeDimension: "order_date",
        }),
      ).toThrow(/not a valid grain token/);
    });
  });

  // ── dimension identifier safety. A dimension is backtick-quoted at
  // interpolation, so an injection-shaped name is neutralized (inert quoted
  // column), and only an unquotable (control-char) name throws.
  describe("buildMetricSql dimension identifier safety (quoting)", () => {
    const registration: MetricRegistration = {
      key: "revenue",
      source: "cat.sch.revenue_metrics",
      lane: "sp",
    };

    test("neutralizes an injection-shaped dimension by quoting", () => {
      const { statement } = buildMetricSql(registration, {
        measures: ["arr"],
        dimensions: ["region; DROP TABLE users"],
      });
      expect(statement).toBe(
        "SELECT MEASURE(`arr`) AS `arr`, `region; DROP TABLE users` FROM `cat`.`sch`.`revenue_metrics` GROUP BY ALL",
      );
    });

    test("neutralizes a backtick in a dimension by doubling it", () => {
      const { statement } = buildMetricSql(registration, {
        measures: ["arr"],
        dimensions: ["region`"],
      });
      expect(statement).toBe(
        "SELECT MEASURE(`arr`) AS `arr`, `region``` FROM `cat`.`sch`.`revenue_metrics` GROUP BY ALL",
      );
    });

    test("throws for a dimension containing a control character", () => {
      expect(() =>
        buildMetricSql(registration, {
          measures: ["arr"],
          dimensions: ["region\tbad"],
        }),
      ).toThrow(/not a valid identifier|control character/);
    });
  });

  // ── orderBy identifier safety. `renderOrderByClause` re-gates each field
  // rather than trusting the validator, because `buildMetricSql` is exported and
  // reachable on paths that never ran the request schema.
  describe("buildMetricSql orderBy identifier safety (quoting)", () => {
    const registration: MetricRegistration = {
      key: "revenue",
      source: "cat.sch.revenue_metrics",
      lane: "sp",
    };

    test("neutralizes an injection-shaped orderBy field by quoting", () => {
      const { statement } = buildMetricSql(registration, {
        measures: ["arr; DROP TABLE users"],
        orderBy: [{ field: "arr; DROP TABLE users" }],
      });
      expect(statement).toBe(
        "SELECT MEASURE(`arr; DROP TABLE users`) AS `arr; DROP TABLE users` FROM `cat`.`sch`.`revenue_metrics` ORDER BY `arr; DROP TABLE users`",
      );
    });

    test("neutralizes a backtick in an orderBy field by doubling it", () => {
      const { statement } = buildMetricSql(registration, {
        measures: ["arr`"],
        orderBy: [{ field: "arr`", direction: "DESC" }],
      });
      expect(statement).toBe(
        "SELECT MEASURE(`arr```) AS `arr``` FROM `cat`.`sch`.`revenue_metrics` ORDER BY `arr``` DESC",
      );
    });

    test("throws for an orderBy field containing a control character", () => {
      expect(() =>
        buildMetricSql(registration, {
          measures: ["arr"],
          orderBy: [{ field: "arr\tbad" }],
        }),
      ).toThrow(/not a valid identifier|control character/);
    });
  });

  // ── orderBy clause: explicit ordering, direction normalization, deterministic
  // default completion, and cache-key semantics. The orderBy feature adds
  // `ORDER BY <fields>` between `GROUP BY ALL` and `LIMIT`.
  describe("buildMetricSql orderBy (explicit ordering)", () => {
    const registration: MetricRegistration = {
      key: "revenue",
      source: "cat.sch.revenue_metrics",
      lane: "sp",
    };

    test("single explicit orderBy key without limit → ORDER BY (no tie-breaker)", () => {
      const { statement } = buildMetricSql(registration, {
        measures: ["arr"],
        dimensions: ["region"],
        orderBy: [{ field: "region" }],
      });
      expect(statement).toBe(
        "SELECT MEASURE(`arr`) AS `arr`, `region` FROM `cat`.`sch`.`revenue_metrics` GROUP BY ALL ORDER BY `region`",
      );
    });

    test("orderBy direction: DESC → renders ` DESC` suffix", () => {
      const { statement } = buildMetricSql(registration, {
        measures: ["arr"],
        dimensions: ["region"],
        orderBy: [{ field: "region", direction: "DESC" }],
      });
      expect(statement).toBe(
        "SELECT MEASURE(`arr`) AS `arr`, `region` FROM `cat`.`sch`.`revenue_metrics` GROUP BY ALL ORDER BY `region` DESC",
      );
    });

    test("orderBy direction: ASC explicitly → renders WITHOUT ASC keyword (SQL default)", () => {
      const { statement } = buildMetricSql(registration, {
        measures: ["arr"],
        dimensions: ["region"],
        orderBy: [{ field: "region", direction: "ASC" }],
      });
      expect(statement).toBe(
        "SELECT MEASURE(`arr`) AS `arr`, `region` FROM `cat`.`sch`.`revenue_metrics` GROUP BY ALL ORDER BY `region`",
      );
    });

    test("multi-key orderBy preserves caller order (not sorted)", () => {
      const { statement: stmt1 } = buildMetricSql(registration, {
        measures: ["arr"],
        dimensions: ["region", "segment"],
        orderBy: [{ field: "region" }, { field: "segment" }],
      });
      expect(stmt1).toBe(
        "SELECT MEASURE(`arr`) AS `arr`, `region`, `segment` FROM `cat`.`sch`.`revenue_metrics` GROUP BY ALL ORDER BY `region`, `segment`",
      );

      // Reversed order produces different SQL (proves entries are not sorted).
      const { statement: stmt2 } = buildMetricSql(registration, {
        measures: ["arr"],
        dimensions: ["region", "segment"],
        orderBy: [{ field: "segment" }, { field: "region" }],
      });
      expect(stmt2).toBe(
        "SELECT MEASURE(`arr`) AS `arr`, `region`, `segment` FROM `cat`.`sch`.`revenue_metrics` GROUP BY ALL ORDER BY `segment`, `region`",
      );
      expect(stmt1).not.toBe(stmt2);
    });

    test("orderBy can name a measure", () => {
      const { statement } = buildMetricSql(registration, {
        measures: ["arr", "revenue"],
        dimensions: ["region"],
        orderBy: [{ field: "revenue" }],
      });
      expect(statement).toBe(
        "SELECT MEASURE(`arr`) AS `arr`, MEASURE(`revenue`) AS `revenue`, `region` FROM `cat`.`sch`.`revenue_metrics` GROUP BY ALL ORDER BY `revenue`",
      );
    });

    test("orderBy can name a dimension", () => {
      const { statement } = buildMetricSql(registration, {
        measures: ["arr"],
        dimensions: ["order_date", "region"],
        orderBy: [{ field: "order_date" }],
      });
      expect(statement).toBe(
        "SELECT MEASURE(`arr`) AS `arr`, `order_date`, `region` FROM `cat`.`sch`.`revenue_metrics` GROUP BY ALL ORDER BY `order_date`",
      );
    });

    test("orderBy naming the timeDimension with timeGrain → ORDER BY bare column (no date_trunc in clause)", () => {
      const { statement } = buildMetricSql(registration, {
        measures: ["arr"],
        dimensions: ["order_date", "region"],
        timeGrain: "month",
        timeDimension: "order_date",
        orderBy: [{ field: "order_date" }],
      });
      expect(statement).toBe(
        "SELECT MEASURE(`arr`) AS `arr`, date_trunc('month', `order_date`) AS `order_date`, `region` FROM `cat`.`sch`.`revenue_metrics` GROUP BY ALL ORDER BY `order_date`",
      );
    });
  });

  // ── orderBy deterministic default (tie-breaker completion): when limit is
  // set and no orderBy is provided, the builder appends ALL dimensions in
  // sorted order as a tie-breaker to ensure deterministic results under LIMIT.
  describe("buildMetricSql orderBy deterministic default (tie-breaker completion)", () => {
    const registration: MetricRegistration = {
      key: "revenue",
      source: "cat.sch.revenue_metrics",
      lane: "sp",
    };

    test("limit set + no orderBy → appends all dimensions in sorted order", () => {
      const { statement } = buildMetricSql(registration, {
        measures: ["arr"],
        dimensions: ["region", "segment"],
        limit: 100,
      });
      expect(statement).toBe(
        "SELECT MEASURE(`arr`) AS `arr`, `region`, `segment` FROM `cat`.`sch`.`revenue_metrics` GROUP BY ALL ORDER BY `region`, `segment` LIMIT 100",
      );
    });

    test("limit set + no orderBy + two dimensions → tie-breaker preserves sorted order", () => {
      const { statement } = buildMetricSql(registration, {
        measures: ["arr"],
        dimensions: ["zebra", "apple"],
        limit: 100,
      });
      expect(statement).toBe(
        "SELECT MEASURE(`arr`) AS `arr`, `apple`, `zebra` FROM `cat`.`sch`.`revenue_metrics` GROUP BY ALL ORDER BY `apple`, `zebra` LIMIT 100",
      );
    });

    test("limit set + no orderBy + no dimensions → no ORDER BY clause (pure aggregate)", () => {
      const { statement } = buildMetricSql(registration, {
        measures: ["arr"],
        limit: 100,
      });
      expect(statement).toBe(
        "SELECT MEASURE(`arr`) AS `arr` FROM `cat`.`sch`.`revenue_metrics` LIMIT 100",
      );
    });

    test("no limit + dimensions + no orderBy → no ORDER BY clause", () => {
      const { statement } = buildMetricSql(registration, {
        measures: ["arr"],
        dimensions: ["region", "segment"],
      });
      expect(statement).toBe(
        "SELECT MEASURE(`arr`) AS `arr`, `region`, `segment` FROM `cat`.`sch`.`revenue_metrics` GROUP BY ALL",
      );
    });

    test("limit set + explicit orderBy naming one of two dimensions → explicit key first, then unnamed dimension appended", () => {
      const { statement } = buildMetricSql(registration, {
        measures: ["arr"],
        dimensions: ["region", "segment"],
        limit: 100,
        orderBy: [{ field: "segment" }],
      });
      expect(statement).toBe(
        "SELECT MEASURE(`arr`) AS `arr`, `region`, `segment` FROM `cat`.`sch`.`revenue_metrics` GROUP BY ALL ORDER BY `segment`, `region` LIMIT 100",
      );
    });

    test("limit set + explicit orderBy naming a measure → measure first, all dimensions appended in sorted order", () => {
      const { statement } = buildMetricSql(registration, {
        measures: ["arr", "revenue"],
        dimensions: ["region", "segment"],
        limit: 100,
        orderBy: [{ field: "revenue" }],
      });
      expect(statement).toBe(
        "SELECT MEASURE(`arr`) AS `arr`, MEASURE(`revenue`) AS `revenue`, `region`, `segment` FROM `cat`.`sch`.`revenue_metrics` GROUP BY ALL ORDER BY `revenue`, `region`, `segment` LIMIT 100",
      );
    });

    test("explicit orderBy + no limit → honored WITHOUT tie-breaker completion", () => {
      const { statement } = buildMetricSql(registration, {
        measures: ["arr"],
        dimensions: ["region", "segment"],
        orderBy: [{ field: "segment" }],
      });
      expect(statement).toBe(
        "SELECT MEASURE(`arr`) AS `arr`, `region`, `segment` FROM `cat`.`sch`.`revenue_metrics` GROUP BY ALL ORDER BY `segment`",
      );
    });
  });

  // ── Envelope parity — streams warehouse_status* then a `result` message,
  // the same event shape as the /query route's JSON SSE path.
  describe("_handleMetricRoute SSE envelope", () => {
    test("streams warehouse_status then a result message with aliased rows", async () => {
      const plugin = pluginForDir(
        config,
        registryDir({
          revenue: {
            key: "revenue",
            source: "cat.sch.revenue_metrics",
            lane: "sp",
          },
        }),
      );
      const { router, getHandler } = createMockRouter();

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
          statement:
            "SELECT MEASURE(`arr`) AS `arr` FROM `cat`.`sch`.`revenue_metrics`",
          warehouseId: "test-warehouse-id",
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

    test("emits warehouse_status before result", async () => {
      const plugin = pluginForDir(
        config,
        registryDir({
          revenue: {
            key: "revenue",
            source: "cat.sch.revenue_metrics",
            lane: "sp",
          },
        }),
      );
      const { router, getHandler } = createMockRouter();

      const executeMock = vi.fn().mockResolvedValue({
        result: { data: [{ arr: 1 }] },
      });
      (plugin as any).SQLClient.executeStatement = executeMock;

      plugin.injectRoutes(router);
      const handler = getHandler("POST", "/metric/:key");

      // The route resolves its warehouse client via getWorkspaceClient() ->
      // ServiceContext (NOT the request), so install it there. A warehouse that
      // is already RUNNING still emits one warehouse_status event before the
      // result — which is what this test pins, without a poll/sleep cycle.
      const warehouseGet = vi.fn().mockResolvedValue({ state: "RUNNING" });
      serviceContextMock.restore();
      serviceContextMock = await mockServiceContext({
        serviceDatabricksClient: {
          statementExecution: {
            executeStatement: vi.fn().mockResolvedValue({
              status: { state: "SUCCEEDED" },
              result: { data: [] },
            }),
          },
          warehouses: { getWarehouse: warehouseGet, startWarehouse: vi.fn() },
        },
      });
      const mockReq = createMockRequest({
        params: { key: "revenue" },
        body: { measures: ["arr"] },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

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
      const plugin = pluginForDir(
        config,
        registryDir({
          revenue: {
            key: "revenue",
            source: "cat.sch.revenue_metrics",
            lane: "sp",
          },
        }),
      );
      const { router, getHandler } = createMockRouter();

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

    // ── Metadata stamping. The injected `metricViewsMetadata` is sliced to the
    // requested columns and stamped into the `result` message; it is pure
    // decoration (no SQL / cache-key effect). See `selectMetricMetadata` below
    // for the unit-level scoping tests.
    const REVENUE_METADATA: MetricViewsMetadata = {
      revenue: {
        measures: {
          arr: { type: "decimal", display_name: "ARR", format: "currency" },
          mrr: { type: "decimal", display_name: "MRR" },
        },
        dimensions: {
          region: { type: "string", display_name: "Region" },
          segment: { type: "string" },
        },
      },
    };

    /** Extract the parsed `result` SSE payload from the mock response writes. */
    function readResultPayload(mockRes: ReturnType<typeof createMockResponse>) {
      const dataLine = (mockRes.write as any).mock.calls
        .map((call: any[]) => call[0] as string)
        .find(
          (s: string) =>
            s.startsWith("data: ") && s.includes('"type":"result"'),
        );
      if (!dataLine) return undefined;
      return JSON.parse(dataLine.slice("data: ".length).trim());
    }

    test("stamps the per-column metadata slice into the result message", async () => {
      const plugin = pluginForDir(
        { ...config, metricViewsMetadata: REVENUE_METADATA },
        registryDir({
          revenue: {
            key: "revenue",
            source: "cat.sch.revenue_metrics",
            lane: "sp",
          },
        }),
      );
      const { router, getHandler } = createMockRouter();
      (plugin as any).SQLClient.executeStatement = vi.fn().mockResolvedValue({
        result: { data: [{ arr: 1234, region: "EMEA" }] },
      });

      plugin.injectRoutes(router);
      const handler = getHandler("POST", "/metric/:key");
      const mockRes = createMockResponse();
      await handler(
        createMockRequest({
          params: { key: "revenue" },
          body: { measures: ["arr"], dimensions: ["region"] },
        }),
        mockRes,
      );

      const payload = readResultPayload(mockRes);
      // Only the requested columns are present — `mrr`/`segment` are omitted.
      expect(payload.metadata).toEqual({
        arr: { type: "decimal", display_name: "ARR", format: "currency" },
        region: { type: "string", display_name: "Region" },
      });
    });

    // ── The "no metadata for this key" warning names a remedy, so it must know
    // which source it is talking about: regenerating types cannot fix an
    // injected value, and the bundle is not read at all on that path.
    test("a key missing from the injected metadata does not advise regenerating types", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const plugin = pluginForDir(
        // Injected metadata that covers `revenue` but not `costs`.
        { ...config, metricViewsMetadata: REVENUE_METADATA },
        registryDir({
          costs: { key: "costs", source: "cat.sch.cost_metrics", lane: "sp" },
        }),
      );
      const { router, getHandler } = createMockRouter();
      (plugin as any).SQLClient.executeStatement = vi.fn().mockResolvedValue({
        result: { data: [{ spend: 1 }] },
      });

      plugin.injectRoutes(router);
      const handler = getHandler("POST", "/metric/:key");
      await handler(
        createMockRequest({
          params: { key: "costs" },
          body: { measures: ["spend"] },
        }),
        createMockResponse(),
      );

      const warnings = warnSpy.mock.calls.map((c) => c.join(" "));
      const missing = warnings.filter((w) =>
        w.includes("No display metadata for metric key"),
      );
      expect(missing.length).toBeGreaterThan(0);
      expect(missing.join(" ")).toContain("injected metricViewsMetadata");
      // The generated bundle is never consulted on the injected path, so
      // naming it here would send the operator after the wrong file.
      expect(missing.join(" ")).not.toContain("regenerate types");
      expect(missing.join(" ")).not.toContain("metadata.generated.json");
      warnSpy.mockRestore();
    });

    test("a key missing from the discovered bundle advises regenerating types", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const dir = registryDir({
        costs: { key: "costs", source: "cat.sch.cost_metrics", lane: "sp" },
      });
      // A bundle must exist for this branch to be reachable: an absent bundle
      // resolves to `undefined`, which is dormancy rather than a stale bundle.
      // It covers `revenue` but not the `costs` key being queried.
      writeFileSync(
        path.join(dir, "metadata.generated.json"),
        JSON.stringify({
          version: 1,
          metricViews: {
            revenue: {
              measures: { arr: { type: "double" } },
              dimensions: {},
            },
          },
        }),
      );
      const plugin = pluginForDir(config, dir); // no injection → discovery path
      const { router, getHandler } = createMockRouter();
      (plugin as any).SQLClient.executeStatement = vi.fn().mockResolvedValue({
        result: { data: [{ spend: 1 }] },
      });

      plugin.injectRoutes(router);
      const handler = getHandler("POST", "/metric/:key");
      await handler(
        createMockRequest({
          params: { key: "costs" },
          body: { measures: ["spend"] },
        }),
        createMockResponse(),
      );

      const warnings = warnSpy.mock.calls.map((c) => c.join(" "));
      const missing = warnings.filter((w) =>
        w.includes("No display metadata for metric key"),
      );
      expect(missing.length).toBeGreaterThan(0);
      // Regenerating types is the correct remedy here, and it names the file to
      // regenerate — the opposite of the injected path above.
      expect(missing.join(" ")).toContain("regenerate types");
      expect(missing.join(" ")).toContain("metadata.generated.json");
      expect(missing.join(" ")).not.toContain("injected metricViewsMetadata");
      warnSpy.mockRestore();
    });

    test("omits the metadata field entirely when no metadata is injected (envelope parity with /query)", async () => {
      const plugin = pluginForDir(
        config, // no metricViewsMetadata
        registryDir({
          revenue: {
            key: "revenue",
            source: "cat.sch.revenue_metrics",
            lane: "sp",
          },
        }),
      );
      const { router, getHandler } = createMockRouter();
      (plugin as any).SQLClient.executeStatement = vi.fn().mockResolvedValue({
        result: { data: [{ arr: 1234 }] },
      });

      plugin.injectRoutes(router);
      const handler = getHandler("POST", "/metric/:key");
      const mockRes = createMockResponse();
      await handler(
        createMockRequest({
          params: { key: "revenue" },
          body: { measures: ["arr"] },
        }),
        mockRes,
      );

      const payload = readResultPayload(mockRes);
      // Envelope parity with a plain `/query` result: the `metadata` key is
      // absent, not present-but-undefined.
      expect(payload).toBeDefined();
      expect(Object.hasOwn(payload, "metadata")).toBe(false);
      expect(payload.data).toEqual([{ arr: 1234 }]);
    });

    test("omits metadata when only degraded/unknown columns are requested", async () => {
      const plugin = pluginForDir(
        { ...config, metricViewsMetadata: REVENUE_METADATA },
        registryDir({
          revenue: {
            key: "revenue",
            source: "cat.sch.revenue_metrics",
            lane: "sp",
          },
        }),
      );
      const { router, getHandler } = createMockRouter();
      (plugin as any).SQLClient.executeStatement = vi.fn().mockResolvedValue({
        result: { data: [{ unknown_measure: 1 }] },
      });

      plugin.injectRoutes(router);
      const handler = getHandler("POST", "/metric/:key");
      const mockRes = createMockResponse();
      await handler(
        createMockRequest({
          params: { key: "revenue" },
          body: { measures: ["unknown_measure"] },
        }),
        mockRes,
      );

      const payload = readResultPayload(mockRes);
      expect(Object.hasOwn(payload, "metadata")).toBe(false);
    });

    test("metadata presence does NOT change the SQL or the cache key", async () => {
      const registry = {
        revenue: {
          key: "revenue",
          source: "cat.sch.revenue_metrics",
          lane: "sp" as const,
        },
      };
      const body = { measures: ["arr"], dimensions: ["region"] };
      const executeMock = vi.fn().mockResolvedValue({
        result: { data: [{ arr: 1, region: "EMEA" }] },
      });

      // Capture the composed cache key the inner `execute` hands to the shared
      // CacheManager mock — the same key whether or not metadata is injected.
      const cacheKeyFor = async (mvMeta?: MetricViewsMetadata) => {
        mockCacheInstance.getOrExecute.mockClear();
        const plugin = pluginForDir(
          { ...config, metricViewsMetadata: mvMeta },
          registryDir(registry),
        );
        (plugin as any).SQLClient.executeStatement = executeMock;
        const { router, getHandler } = createMockRouter();
        plugin.injectRoutes(router);
        const handler = getHandler("POST", "/metric/:key");
        await handler(
          createMockRequest({ params: { key: "revenue" }, body }),
          createMockResponse(),
        );
        // First getOrExecute call is the SQL execution's cache interceptor.
        const call = mockCacheInstance.getOrExecute.mock.calls[0];
        return { cacheKey: call[0], userKey: call[2] };
      };

      const withMeta = await cacheKeyFor(REVENUE_METADATA);
      const withoutMeta = await cacheKeyFor(undefined);

      expect(withMeta.cacheKey).toEqual(withoutMeta.cacheKey);
      expect(withMeta.userKey).toEqual(withoutMeta.userKey);
      // And the SQL is unchanged (measures/dimensions only).
      expect(executeMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          statement:
            "SELECT MEASURE(`arr`) AS `arr`, `region` FROM `cat`.`sch`.`revenue_metrics` GROUP BY ALL",
        }),
        expect.any(AbortSignal),
      );
    });

    test("a cache hit serves the current metadata, not the copy from cache-fill time", async () => {
      // The cache key excludes metadata, so the SQL result is a hit across the
      // two runs below; only the injected metadata differs. Stamping inside the
      // cached call would replay stale labels/formats after a redeploy.
      const registry = {
        revenue: {
          key: "revenue",
          source: "cat.sch.revenue_metrics",
          lane: "sp" as const,
        },
      };
      const body = { measures: ["arr"], dimensions: ["region"] };
      const executeMock = vi.fn().mockResolvedValue({
        result: { data: [{ arr: 1, region: "EMEA" }] },
      });

      const runWithMetadata = async (mvMeta: MetricViewsMetadata) => {
        const plugin = pluginForDir(
          { ...config, metricViewsMetadata: mvMeta },
          registryDir(registry),
        );
        (plugin as any).SQLClient.executeStatement = executeMock;
        const { router, getHandler } = createMockRouter();
        plugin.injectRoutes(router);
        const handler = getHandler("POST", "/metric/:key");
        const mockRes = createMockResponse();
        await handler(
          createMockRequest({ params: { key: "revenue" }, body }),
          mockRes,
        );
        return readResultPayload(mockRes);
      };

      // First run fills the cache with the old labels.
      const oldMeta: MetricViewsMetadata = {
        revenue: {
          measures: { arr: { type: "decimal", display_name: "ARR (old)" } },
          dimensions: { region: { type: "string", display_name: "Region" } },
        },
      };
      const first = await runWithMetadata(oldMeta);
      expect(first.metadata.arr.display_name).toBe("ARR (old)");

      // Second run: same body → SQL cache hit (executeStatement not called
      // again), but the app now injects new labels, which must reach the
      // response.
      executeMock.mockClear();
      const newMeta: MetricViewsMetadata = {
        revenue: {
          measures: {
            arr: {
              type: "decimal",
              display_name: "ARR (new)",
              format: "$#,##0",
            },
          },
          dimensions: { region: { type: "string", display_name: "Region" } },
        },
      };
      const second = await runWithMetadata(newMeta);

      expect(executeMock).not.toHaveBeenCalled(); // SQL served from cache
      expect(second.metadata.arr.display_name).toBe("ARR (new)");
      expect(second.metadata.arr.format).toBe("$#,##0");
    });
  });

  // ── 503-vs-404 latching + dormancy.
  describe("registry latching and dormancy", () => {
    test("unknown key against a valid registry → 404 (generic body)", async () => {
      const plugin = pluginForDir(
        config,
        registryDir({
          revenue: {
            key: "revenue",
            source: "cat.sch.revenue_metrics",
            lane: "sp",
          },
        }),
      );
      const { router, getHandler } = createMockRouter();

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

    test.each(["__proto__", "constructor", "toString", "hasOwnProperty"])(
      "inherited Object.prototype key %j → 404, no execution (own-property lookup)",
      async (dangerousKey) => {
        const plugin = pluginForDir(
          config,
          registryDir({
            revenue: {
              key: "revenue",
              source: "cat.sch.revenue_metrics",
              lane: "sp",
            },
          }),
        );
        const { router, getHandler } = createMockRouter();
        // A real (own) entry so the registry is populated but does NOT contain
        // the dangerous key. Without the own-property guard, `registry[key]`
        // would resolve the inherited prototype member and slip past the 404.

        const executeMock = vi.fn();
        (plugin as any).SQLClient.executeStatement = executeMock;

        plugin.injectRoutes(router);
        const handler = getHandler("POST", "/metric/:key");
        const mockReq = createMockRequest({
          params: { key: dangerousKey },
          body: { measures: ["arr"] },
        });
        const mockRes = createMockResponse();

        await handler(mockReq, mockRes);

        expect(mockRes.status).toHaveBeenCalledWith(404);
        expect(mockRes.json).toHaveBeenCalledWith({
          error: "Metric not found",
        });
        expect(executeMock).not.toHaveBeenCalled();
      },
    );

    test("malformed registry → 503 METRIC_REGISTRY_LOAD_FAILED", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "mv-route-"));
      tempRegistryDirs.push(dir);
      // A real malformed config on disk (invalid JSON) → the loader throws →
      // the route surfaces a 503, exercising the actual load path.
      writeRegistry(dir, "{ not valid json");
      const plugin = pluginForDir(config, dir);
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
      expect(mockRes.json).toHaveBeenCalledWith({
        error: "Metric registry not available",
        code: "METRIC_REGISTRY_LOAD_FAILED",
      });
    });

    test("self-heal: a fixed config is picked up on the next request (no restart)", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "mv-route-"));
      tempRegistryDirs.push(dir);
      writeRegistry(dir, "{ not valid json");
      const plugin = pluginForDir(config, dir);
      const { router, getHandler } = createMockRouter();
      const executeMock = vi
        .fn()
        .mockResolvedValue({ result: { data: [{ arr: 1 }] } });
      (plugin as any).SQLClient.executeStatement = executeMock;
      plugin.injectRoutes(router);
      const handler = getHandler("POST", "/metric/:key");

      // First request: malformed → 503, and the failure is NOT cached.
      const res1 = createMockResponse();
      await handler(
        createMockRequest({
          params: { key: "revenue" },
          body: { measures: ["arr"] },
        }),
        res1,
      );
      expect(res1.status).toHaveBeenCalledWith(503);

      // Fix the file. Each request re-reads + re-parses the config, so the
      // next request serves it — no server restart, no latched 503.
      writeRegistry(dir, {
        revenue: {
          key: "revenue",
          source: "cat.sch.revenue_metrics",
          lane: "sp",
        },
      });
      const res2 = createMockResponse();
      await handler(
        createMockRequest({
          params: { key: "revenue" },
          body: { measures: ["arr"] },
        }),
        res2,
      );
      expect(res2.status).not.toHaveBeenCalledWith(503);
      expect(res2.status).not.toHaveBeenCalledWith(404);
      expect(executeMock).toHaveBeenCalled();
    });

    test("hot-reload: a new key added to a working config is visible next request", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "mv-route-"));
      tempRegistryDirs.push(dir);
      writeRegistry(dir, {
        revenue: {
          key: "revenue",
          source: "cat.sch.revenue_metrics",
          lane: "sp",
        },
      });
      const plugin = pluginForDir(config, dir);
      const { router, getHandler } = createMockRouter();
      const executeMock = vi
        .fn()
        .mockResolvedValue({ result: { data: [{ arr: 1 }] } });
      (plugin as any).SQLClient.executeStatement = executeMock;
      plugin.injectRoutes(router);
      const handler = getHandler("POST", "/metric/:key");

      // `orders` is not registered yet → 404.
      const res1 = createMockResponse();
      await handler(
        createMockRequest({
          params: { key: "orders" },
          body: { measures: ["cnt"] },
        }),
        res1,
      );
      expect(res1.status).toHaveBeenCalledWith(404);

      // Add `orders` to the config. Each request re-reads the config, so the
      // next request sees it without a restart.
      writeRegistry(dir, {
        revenue: {
          key: "revenue",
          source: "cat.sch.revenue_metrics",
          lane: "sp",
        },
        orders: { key: "orders", source: "cat.sch.order_metrics", lane: "sp" },
      });
      const res2 = createMockResponse();
      await handler(
        createMockRequest({
          params: { key: "orders" },
          body: { measures: ["cnt"] },
        }),
        res2,
      );
      expect(res2.status).not.toHaveBeenCalledWith(404);
      expect(executeMock).toHaveBeenCalled();
    });

    test("no definitions.json present → registry empty, unknown key 404, nothing executes", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      const executeMock = vi.fn();
      (plugin as any).SQLClient.executeStatement = executeMock;
      // Registry lazily loads from cwd; no config/metric-views/definitions.json
      // in the test cwd → empty registry (dormant).
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
// The loader reads the config file THROUGH an `AppManager`, so each test points
// an `AppManager` at its temp dir instead of passing a bare directory string.
// The loader is stateless — it reads + parses on every call
// (no memoization), so there is no cache to reset between tests.
describe("loadMetricRegistry", () => {
  let dir: string;
  let app: AppManager;

  beforeEach(() => {
    // `dir` is the metric-views config dir; the loader reads its
    // `definitions.json`. The queries dir (first arg) is unused by this path.
    dir = mkdtempSync(path.join(tmpdir(), "mv-registry-"));
    app = new AppManager(path.join(dir, "queries"), dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("absent definitions.json → empty registry (dormancy)", async () => {
    expect(await loadMetricRegistry(app)).toEqual({});
  });

  test("derives lane from executor (default sp, user → obo)", async () => {
    writeFileSync(
      path.join(dir, "definitions.json"),
      JSON.stringify({
        metricViews: {
          revenue: { source: "cat.sch.revenue_metrics" },
          customers: { source: "cat.sch.customer_metrics", executor: "user" },
        },
      }),
    );

    const registry = await loadMetricRegistry(app);
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

  test("registry has a null prototype (no inherited-property lookups)", async () => {
    writeFileSync(
      path.join(dir, "definitions.json"),
      JSON.stringify({
        metricViews: { revenue: { source: "cat.sch.revenue_metrics" } },
      }),
    );

    const registry = await loadMetricRegistry(app);
    expect(Object.getPrototypeOf(registry)).toBeNull();
    // A key that would resolve to a truthy inherited member on a plain object
    // resolves to undefined here.
    expect((registry as Record<string, unknown>).toString).toBeUndefined();
    expect((registry as Record<string, unknown>).__proto__).toBeUndefined();
  });

  test("absent file yields a null-prototype (dormant) registry too", async () => {
    // The ENOENT dormancy path must also be prototype-free — a metric key
    // colliding with an inherited member can't 200 against an empty registry.
    const registry = await loadMetricRegistry(app);
    expect(Object.getPrototypeOf(registry)).toBeNull();
  });

  test("malformed JSON throws", async () => {
    writeFileSync(path.join(dir, "definitions.json"), "{ not json");
    await expect(loadMetricRegistry(app)).rejects.toThrow(/Failed to parse/);
  });

  // ── The generated metadata bundle. Unlike definitions.json, every failure
  // mode here degrades to `undefined` instead of throwing: metadata is pure
  // response decoration, so a bad bundle must never fail a working query.
  describe("loadMetricMetadata", () => {
    const bundle = (extra?: Record<string, unknown>) =>
      JSON.stringify({
        version: 1,
        metricViews: {
          revenue: {
            measures: { arr: { type: "double", format: "$#,##0.00" } },
            dimensions: { region: { type: "string", display_name: "Region" } },
          },
        },
        ...extra,
      });

    test("absent bundle → undefined (dormancy)", async () => {
      expect(await loadMetricMetadata(app)).toBeUndefined();
    });

    test("reads per-column metadata for a valid bundle", async () => {
      writeFileSync(path.join(dir, "metadata.generated.json"), bundle());
      const metadata = await loadMetricMetadata(app);
      expect(metadata?.revenue).toEqual({
        measures: { arr: { type: "double", format: "$#,##0.00" } },
        dimensions: { region: { type: "string", display_name: "Region" } },
      });
    });

    test("result has a null prototype (no inherited-property lookups)", async () => {
      writeFileSync(path.join(dir, "metadata.generated.json"), bundle());
      const metadata = await loadMetricMetadata(app);
      expect(Object.getPrototypeOf(metadata)).toBeNull();
      expect(
        (metadata as unknown as Record<string, unknown>).toString,
      ).toBeUndefined();
    });

    test("malformed JSON → undefined, never throws", async () => {
      writeFileSync(path.join(dir, "metadata.generated.json"), "{ not json");
      await expect(loadMetricMetadata(app)).resolves.toBeUndefined();
    });

    test("schema-invalid bundle → undefined, never throws", async () => {
      writeFileSync(
        path.join(dir, "metadata.generated.json"),
        JSON.stringify({ version: 1, metricViews: { revenue: "nope" } }),
      );
      await expect(loadMetricMetadata(app)).resolves.toBeUndefined();
    });

    test("a future bundle version is ignored rather than mis-parsed", async () => {
      writeFileSync(
        path.join(dir, "metadata.generated.json"),
        JSON.stringify({ version: 99, metricViews: {} }),
      );
      await expect(loadMetricMetadata(app)).resolves.toBeUndefined();
    });

    test("tolerates unknown per-column fields from a newer generator", async () => {
      // Non-strict per-column schema: an older runtime keeps serving the fields
      // it understands instead of rejecting the whole bundle.
      writeFileSync(
        path.join(dir, "metadata.generated.json"),
        JSON.stringify({
          version: 1,
          metricViews: {
            revenue: {
              measures: { arr: { type: "double", unit_of_measure: "USD" } },
              dimensions: {},
            },
          },
        }),
      );
      const metadata = await loadMetricMetadata(app);
      expect(metadata?.revenue.measures.arr.type).toBe("double");
    });

    test("picks up an edited bundle rather than serving a stale parse", async () => {
      const file = path.join(dir, "metadata.generated.json");
      writeFileSync(file, bundle());
      expect((await loadMetricMetadata(app))?.revenue.measures.arr.format).toBe(
        "$#,##0.00",
      );

      // The parse cache is keyed on raw contents, so a regenerated bundle is
      // reflected without a restart (matters for the dev-tunnel path).
      writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          metricViews: {
            revenue: {
              measures: { arr: { type: "double", format: "€#,##0" } },
              dimensions: {},
            },
          },
        }),
      );
      expect((await loadMetricMetadata(app))?.revenue.measures.arr.format).toBe(
        "€#,##0",
      );
    });
  });

  test("schema-invalid config throws", async () => {
    writeFileSync(
      path.join(dir, "definitions.json"),
      JSON.stringify({
        metricViews: { revenue: { source: "not-a-three-part-fqn" } },
      }),
    );
    await expect(loadMetricRegistry(app)).rejects.toThrow(
      /Invalid definitions.json/,
    );
  });

  test("rejects more than 200 metric views (runtime parity with typegen cap)", async () => {
    // A config that fails type generation (MAX_METRIC_VIEWS) must not silently
    // pass at runtime. z.record has no `.max` in zod 4, so this is enforced by
    // the schema's superRefine.
    const metricViews: Record<string, { source: string }> = {};
    for (let i = 0; i < 201; i++) {
      metricViews[`m_${i}`] = { source: `cat.sch.view_${i}` };
    }
    writeFileSync(
      path.join(dir, "definitions.json"),
      JSON.stringify({ metricViews }),
    );
    await expect(loadMetricRegistry(app)).rejects.toThrow(
      /Invalid definitions.json/,
    );
  });

  test("rejects an FQN segment longer than 255 chars (per-segment cap)", async () => {
    // The per-segment length cap is not expressible as a whole-string
    // maxLength; the schema's superRefine enforces it so runtime matches the
    // typegen resolver.
    const longSegment = "a".repeat(256);
    writeFileSync(
      path.join(dir, "definitions.json"),
      JSON.stringify({
        metricViews: { revenue: { source: `cat.sch.${longSegment}` } },
      }),
    );
    await expect(loadMetricRegistry(app)).rejects.toThrow(
      /Invalid definitions.json/,
    );
  });

  test("accepts exactly 200 views and a 255-char segment (boundary)", async () => {
    const metricViews: Record<string, { source: string }> = {};
    for (let i = 0; i < 200; i++) {
      metricViews[`m_${i}`] = { source: `cat.sch.view_${i}` };
    }
    // One entry with a segment at exactly the 255 limit — must pass.
    metricViews.m_0 = { source: `cat.sch.${"a".repeat(255)}` };
    writeFileSync(
      path.join(dir, "definitions.json"),
      JSON.stringify({ metricViews }),
    );
    await expect(loadMetricRegistry(app)).resolves.toBeDefined();
  });
});

// ── The structured filter engine (translator + validator). Registry-free:
// names are grammar-gated, values are parameterized. No allowlist, no
// op⇄dimension-type check.
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
      expect(where).toBe("`region` = :f_0");
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
      expect(where).toBe("`region` <> :f_0");
      expect(parameters.f_0).toEqual({ __sql_type: "STRING", value: "EMEA" });
    });

    test("in → `<col> IN (:f_0, :f_1, ...)`", () => {
      const { where, parameters } = render({
        member: "region",
        operator: "in",
        values: ["EMEA", "APAC", "AMER"],
      });
      expect(where).toBe("`region` IN (:f_0, :f_1, :f_2)");
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
      expect(where).toBe("`region` NOT IN (:f_0, :f_1)");
      expect(Object.keys(parameters)).toHaveLength(2);
    });

    test("gt → `<col> > :f_0` (numeric value bound as INT)", () => {
      const { where, parameters } = render({
        member: "deal_size",
        operator: "gt",
        values: [10000],
      });
      expect(where).toBe("`deal_size` > :f_0");
      expect(parameters.f_0).toEqual({ __sql_type: "INT", value: "10000" });
    });

    test("gte → `<col> >= :f_0`", () => {
      const { where } = render({
        member: "deal_size",
        operator: "gte",
        values: [5000],
      });
      expect(where).toBe("`deal_size` >= :f_0");
    });

    test("lt → `<col> < :f_0`", () => {
      const { where } = render({
        member: "deal_size",
        operator: "lt",
        values: [100],
      });
      expect(where).toBe("`deal_size` < :f_0");
    });

    test("lte → `<col> <= :f_0`", () => {
      const { where } = render({
        member: "deal_size",
        operator: "lte",
        values: [50000],
      });
      expect(where).toBe("`deal_size` <= :f_0");
    });

    test("contains → `<col> LIKE :f_0` (value wrapped in %...%)", () => {
      const { where, parameters } = render({
        member: "region",
        operator: "contains",
        values: ["MEA"],
      });
      expect(where).toBe("`region` LIKE :f_0");
      expect(parameters.f_0).toEqual({ __sql_type: "STRING", value: "%MEA%" });
    });

    test("notContains → `<col> NOT LIKE :f_0`", () => {
      const { where, parameters } = render({
        member: "region",
        operator: "notContains",
        values: ["test"],
      });
      expect(where).toBe("`region` NOT LIKE :f_0");
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
      expect(where).toBe("`region` IS NOT NULL");
      expect(parameters).toEqual({});
    });

    test("notSet → `<col> IS NULL` (no bind)", () => {
      const { where, parameters } = render({
        member: "region",
        operator: "notSet",
      });
      expect(where).toBe("`region` IS NULL");
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
      expect(where).toBe("(`region` = :f_0 AND `segment` = :f_1)");
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
      expect(where).toBe("(`region` = :f_0 OR `region` = :f_1)");
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
      expect(where).toContain("(`region` IN (");
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

    test("empty `and: []` renders 1 = 1 (defense in depth past the validator)", () => {
      // The validator rejects `and: []` (see cardinality tests), but if a
      // bypass ever reaches the renderer, an empty conjunction must render the
      // AND identity element (vacuous-true) so it is correct in any position —
      // returning `null` (dropped) would only be right at the top level, not
      // nested inside an OR (see the OR-of-empty-AND test below). No bind
      // parameters are emitted for the tautology.
      const { where, parameters } = render({ and: [] });
      expect(where).toBe("1 = 1");
      expect(parameters).toEqual({});
    });

    test("empty `or: []` renders 1 = 0 (defense in depth past the validator)", () => {
      // The validator rejects `or: []` (see cardinality tests), but if a bypass
      // ever reaches the renderer, an empty disjunction must render vacuous-
      // false — never drop the predicate (which would mean "match everything").
      const { where } = render({ or: [] });
      expect(where).toBe("1 = 0");
    });

    test("empty `and` nested in `or` stays vacuous-true (does not under-return)", () => {
      // `TRUE OR P` is all rows. If empty-AND returned `null` (dropped by the
      // parent OR), this would collapse to just `P` and under-return. The
      // identity element `1 = 1` keeps the disjunction matching everything.
      // `sortFilterChildren` orders the predicate before the empty-`and` group,
      // so the tautology lands on the right; the disjunction still matches all rows.
      const { where } = render({
        or: [
          { and: [] },
          { member: "region", operator: "equals", values: ["EMEA"] },
        ],
      });
      expect(where).toBe("(`region` = :f_0 OR 1 = 1)");
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

    test("an injection-shaped filter member is neutralized by quoting", () => {
      // No control char → a valid (if nonexistent) column name: quoted whole,
      // the `;`/`DROP`/`--` are inert inside the backtick-delimited identifier.
      const { where } = render({
        member: "region; DROP TABLE foo --",
        operator: "equals",
        values: ["x"],
      });
      expect(where).toBe("`region; DROP TABLE foo --` = :f_0");
    });

    test("a filter member with a control character throws before SQL is built", () => {
      expect(() =>
        render({
          member: "region\ndrop",
          operator: "equals",
          values: ["x"],
        }),
      ).toThrowError(/not a valid identifier|control character/);
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

    test("rejects empty `and` group (renders to no WHERE, would split the cache)", () => {
      // An empty `and` contributes no constraint and renders to no WHERE
      // clause — identical SQL to omitting `filter` — but canonicalizes to a
      // distinct cache key (`and()` vs `_`). Reject it so request shape and
      // cache key stay one-to-one.
      expect(() =>
        validateMetricRequest({
          measures: ["arr"],
          filter: { and: [] },
        }),
      ).toThrowError(/fields:.*filter\.and/);
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
      expect(where).toBe("`ghost_column` = :f_0");
    });
  });

  describe("validator — measure/dimension uniqueness", () => {
    // Measures and dimensions become SELECT columns aliased to their own name;
    // a repeated name collapses to a single row-object key and silently drops
    // a value during row materialization, so uniqueness is enforced up front.
    test("rejects a duplicate measure", () => {
      expect(() =>
        validateMetricRequest({ measures: ["arr", "arr"] }),
      ).toThrowError(/fields:.*measures/);
    });

    test("rejects a duplicate dimension", () => {
      expect(() =>
        validateMetricRequest({
          measures: ["arr"],
          dimensions: ["region", "region"],
        }),
      ).toThrowError(/fields:.*measures/);
    });

    test("rejects a name that is BOTH a measure and a dimension", () => {
      // The corruption case: `SELECT MEASURE(`x`) AS `x`, x ... GROUP BY ALL`
      // materializes two `x` columns and the second overwrites the first.
      expect(() =>
        validateMetricRequest({
          measures: ["revenue"],
          dimensions: ["revenue"],
        }),
      ).toThrowError(/fields:.*measures/);
    });

    test("accepts distinct measures and dimensions (no false positive)", () => {
      expect(() =>
        validateMetricRequest({
          measures: ["arr", "mrr"],
          dimensions: ["region", "segment"],
        }),
      ).not.toThrow();
    });
  });

  describe("validator — format (JSON-only at v1)", () => {
    test("accepts JSON_ARRAY", () => {
      expect(() =>
        validateMetricRequest({ measures: ["arr"], format: "JSON_ARRAY" }),
      ).not.toThrow();
    });

    test("accepts the legacy JSON alias (normalizes to JSON_ARRAY)", () => {
      expect(() =>
        validateMetricRequest({ measures: ["arr"], format: "JSON" }),
      ).not.toThrow();
    });

    test("rejects ARROW_STREAM (not implemented on the metric route)", () => {
      // Fail loud rather than silently deliver JSON for an Arrow request.
      expect(() =>
        validateMetricRequest({ measures: ["arr"], format: "ARROW_STREAM" }),
      ).toThrowError(/fields:.*format/);
    });

    test("rejects the legacy ARROW alias (normalizes to ARROW_STREAM)", () => {
      expect(() =>
        validateMetricRequest({ measures: ["arr"], format: "ARROW" }),
      ).toThrowError(/fields:.*format/);
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

  describe("orderBy (validator)", () => {
    test("valid orderBy with one dimension is accepted", () => {
      expect(() =>
        validateMetricRequest({
          measures: ["arr"],
          dimensions: ["region"],
          orderBy: [{ field: "region" }],
        }),
      ).not.toThrow();
    });

    test("valid orderBy with direction: ASC is accepted", () => {
      expect(() =>
        validateMetricRequest({
          measures: ["arr"],
          dimensions: ["region"],
          orderBy: [{ field: "region", direction: "ASC" }],
        }),
      ).not.toThrow();
    });

    test("valid orderBy with direction: DESC is accepted", () => {
      expect(() =>
        validateMetricRequest({
          measures: ["arr"],
          dimensions: ["region"],
          orderBy: [{ field: "region", direction: "DESC" }],
        }),
      ).not.toThrow();
    });

    test("valid orderBy round-trips unchanged", () => {
      const req = validateMetricRequest({
        measures: ["arr"],
        dimensions: ["region", "segment"],
        orderBy: [{ field: "segment", direction: "DESC" }, { field: "region" }],
      });
      expect(req.orderBy).toEqual([
        { field: "segment", direction: "DESC" },
        { field: "region" },
      ]);
    });

    test("orderBy field must be in measures or dimensions", () => {
      expect(() =>
        validateMetricRequest({
          measures: ["arr"],
          dimensions: ["region"],
          orderBy: [{ field: "unknown_field" }],
        }),
      ).toThrowError(/fields:.*orderBy.*0.*field/);
    });

    test("orderBy field can be a measure", () => {
      expect(() =>
        validateMetricRequest({
          measures: ["arr", "revenue"],
          dimensions: ["region"],
          orderBy: [{ field: "revenue" }],
        }),
      ).not.toThrow();
    });

    test("orderBy rejects an unknown direction value", () => {
      expect(() =>
        validateMetricRequest({
          measures: ["arr"],
          dimensions: ["region"],
          orderBy: [{ field: "region", direction: "UP" as never }],
        }),
      ).toThrowError(/fields:.*orderBy/);
    });

    test("orderBy entry rejects extra properties (strict mode)", () => {
      expect(() =>
        validateMetricRequest({
          measures: ["arr"],
          dimensions: ["region"],
          orderBy: [{ field: "region", extra: "property" } as never],
        }),
      ).toThrowError(/fields:.*orderBy/);
    });

    test("orderBy rejects duplicate fields", () => {
      expect(() =>
        validateMetricRequest({
          measures: ["arr"],
          dimensions: ["region", "segment"],
          orderBy: [{ field: "region" }, { field: "region" }],
        }),
      ).toThrowError(/fields:.*orderBy/);
    });

    test("orderBy rejects empty array", () => {
      expect(() =>
        validateMetricRequest({
          measures: ["arr"],
          dimensions: ["region"],
          orderBy: [],
        }),
      ).toThrowError(/fields:.*orderBy/);
    });

    test("orderBy rejects over-cap (21+ entries)", () => {
      const orderByArray = Array.from({ length: 21 }, (_, i) => ({
        field: `dim_${i}`,
      }));
      expect(() =>
        validateMetricRequest({
          measures: ["arr"],
          dimensions: orderByArray.map((_, i) => `dim_${i}`),
          orderBy: orderByArray as never,
        }),
      ).toThrowError(/fields:.*orderBy/);
    });

    test("orderBy field with control character is rejected", () => {
      expect(() =>
        validateMetricRequest({
          measures: ["arr"],
          dimensions: ["region"],
          orderBy: [{ field: "region\tbad" }],
        }),
      ).toThrowError(/fields:.*orderBy/);
    });

    test("orderBy field missing entirely is rejected (Zod type error)", () => {
      expect(() =>
        validateMetricRequest({
          measures: ["arr"],
          dimensions: ["region"],
          orderBy: [{ direction: "DESC" } as never],
        }),
      ).toThrowError();
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
  // clientMessage/errorCode envelope) lands here because this harness can drive
  // the metric route end-to-end and assert on the SSE error bytes.
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
      const plugin = pluginForDir(
        config,
        registryDir({
          revenue: {
            key: "revenue",
            source: "cat.sch.revenue_metrics",
            lane: "sp",
          },
        }),
      );
      const { router, getHandler } = createMockRouter();

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
            "SELECT MEASURE(`ghost_measure`) AS `ghost_measure` FROM `cat`.`sch`.`revenue_metrics`",
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

// ── cache-key composition. `composeMetricCacheKey` produces the
// array `CacheManager.generateKey` concatenates + sha256s; the invariants
// below are what make the cache both correct (semantically equal calls collapse)
// and safe (distinct args / executors never collide).
describe("composeMetricCacheKey", () => {
  const base: {
    metricKey: string;
    source: string;
    measures: string[];
    format: string;
    executorKey: string;
  } = {
    metricKey: "revenue",
    source: "cat.sch.revenue_metrics",
    measures: ["arr"],
    format: "JSON_ARRAY",
    executorKey: "sp",
  };

  test("same key but different source → different keys (config repoint is not stale-served)", () => {
    const a = composeMetricCacheKey({ ...base, source: "cat.sch.old_view" });
    const b = composeMetricCacheKey({ ...base, source: "cat.sch.new_view" });
    expect(a).not.toEqual(b);
  });

  test("timeDimension does NOT fork the key when timeGrain is absent (no SQL effect)", () => {
    // Without a grain, renderDimensionClause emits the bare column, so
    // timeDimension has no effect on the SQL — two such calls must cache-hit.
    const withTd = composeMetricCacheKey({
      ...base,
      dimensions: ["order_date"],
      timeDimension: "order_date",
    });
    const withoutTd = composeMetricCacheKey({
      ...base,
      dimensions: ["order_date"],
    });
    expect(withTd).toEqual(withoutTd);
  });

  test("timeDimension DOES fork the key when timeGrain is set (changes the SQL)", () => {
    const a = composeMetricCacheKey({
      ...base,
      dimensions: ["order_date", "region"],
      timeGrain: "month",
      timeDimension: "order_date",
    });
    const b = composeMetricCacheKey({
      ...base,
      dimensions: ["order_date", "region"],
      timeGrain: "month",
      timeDimension: "region",
    });
    expect(a).not.toEqual(b);
  });

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

  // A comma is a legal identifier character (`isValidColumnName` rejects only
  // control chars / newlines), so a raw `.join(",")` would collapse a single
  // comma-containing name and a two-name list to the same key element while the
  // generated SQL differs — serving wrong cached rows. JSON encoding keeps the
  // key one-to-one with the SQL.
  test("measures with a comma in a name do NOT collide with a two-measure list", () => {
    const a = composeMetricCacheKey({ ...base, measures: ["a,b"] });
    const b = composeMetricCacheKey({ ...base, measures: ["a", "b"] });
    expect(a).not.toEqual(b);
  });

  test("dimensions with a comma in a name do NOT collide with a two-dimension list", () => {
    const a = composeMetricCacheKey({ ...base, dimensions: ["a,b"] });
    const b = composeMetricCacheKey({ ...base, dimensions: ["a", "b"] });
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

  test("predicate ORDER is stable for two ops on the SAME member (sort-key delimiter)", () => {
    // Same member, different operators — the sort key is `${member}/${operator}`,
    // so the "/" delimiter (not a raw concatenation) is what disambiguates the
    // pair and keeps the ordering — and thus the key — independent of input
    // order. Two range bounds on one column is the everyday shape of this.
    const a = composeMetricCacheKey({
      ...base,
      filter: {
        and: [
          { member: "revenue", operator: "gt", values: [100] },
          { member: "revenue", operator: "lt", values: [200] },
        ],
      } as MetricFilter,
    });
    const b = composeMetricCacheKey({
      ...base,
      filter: {
        and: [
          { member: "revenue", operator: "lt", values: [200] },
          { member: "revenue", operator: "gt", values: [100] },
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

  test("different orderBy → different keys", () => {
    const a = composeMetricCacheKey({
      ...base,
      dimensions: ["region"],
      orderBy: [{ field: "region" }],
    });
    const b = composeMetricCacheKey({
      ...base,
      dimensions: ["region"],
      orderBy: [{ field: "region", direction: "DESC" }],
    });
    expect(a).not.toEqual(b);
  });

  test("orderBy field ORDER matters — sequence is semantic, not sorted (prevents cache collision)", () => {
    // ORDER BY a, b returns different rows than ORDER BY b, a under LIMIT.
    // orderBy is NOT sorted before hashing (unlike measures/dimensions), so the
    // sequence must fork the key. This test guards against a regression.
    const ab = composeMetricCacheKey({
      ...base,
      dimensions: ["a", "b"],
      orderBy: [{ field: "a" }, { field: "b" }],
    });
    const ba = composeMetricCacheKey({
      ...base,
      dimensions: ["a", "b"],
      orderBy: [{ field: "b" }, { field: "a" }],
    });
    expect(ab).not.toEqual(ba);
  });

  test("orderBy direction normalization: absent vs ASC → same key", () => {
    const noDir = composeMetricCacheKey({
      ...base,
      dimensions: ["region"],
      orderBy: [{ field: "region" }],
    });
    const asc = composeMetricCacheKey({
      ...base,
      dimensions: ["region"],
      orderBy: [{ field: "region", direction: "ASC" }],
    });
    expect(noDir).toEqual(asc);
  });

  test("orderBy direction: DESC → different key from absent/ASC", () => {
    const noDir = composeMetricCacheKey({
      ...base,
      dimensions: ["region"],
      orderBy: [{ field: "region" }],
    });
    const desc = composeMetricCacheKey({
      ...base,
      dimensions: ["region"],
      orderBy: [{ field: "region", direction: "DESC" }],
    });
    expect(noDir).not.toEqual(desc);
  });

  test("absent vs present orderBy → different keys", () => {
    const without = composeMetricCacheKey({
      ...base,
      dimensions: ["region"],
    });
    const with_ = composeMetricCacheKey({
      ...base,
      dimensions: ["region"],
      orderBy: [{ field: "region" }],
    });
    expect(without).not.toEqual(with_);
  });
});

// ── executor-key isolation. The key is what scopes the cache — `"sp"`
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

// ── lane dispatch at the handler level. The lane comes from the
// registration (the entry's `executor` in definitions.json), NOT the URL:
// OBO-lane routes through `asUser(req)`, SP-lane through the default executor.
// A missing/whitespace OBO identity must land on the canonical 401 envelope,
// never an out-of-envelope 500.
describe("metric route — lane dispatch", () => {
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
    const plugin = pluginForDir(
      config,
      registryDir({
        revenue: {
          key: "revenue",
          source: "cat.sch.revenue_metrics",
          lane: "obo",
        },
      }),
    );
    const { router, getHandler } = createMockRouter();

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
    const plugin = pluginForDir(
      config,
      registryDir({
        revenue: {
          key: "revenue",
          source: "cat.sch.revenue_metrics",
          lane: "sp",
        },
      }),
    );
    const { router, getHandler } = createMockRouter();

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
    const plugin = pluginForDir(
      config,
      registryDir({
        revenue: {
          key: "revenue",
          source: "cat.sch.revenue_metrics",
          lane: "obo",
        },
      }),
    );
    const { router, getHandler } = createMockRouter();

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
    const plugin = pluginForDir(
      config,
      registryDir({
        revenue: {
          key: "revenue",
          source: "cat.sch.revenue_metrics",
          lane: "obo",
        },
      }),
    );
    const { router, getHandler } = createMockRouter();

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

// ── metadata slicing. `selectMetricMetadata` flattens the injected
// per-metric metadata down to only the requested columns for the SSE `result`
// message. It is pure and total; the invariants below are what keep the stamp
// scoped, degrade-safe, and prototype-safe.
describe("selectMetricMetadata", () => {
  const all: MetricViewsMetadata = {
    revenue: {
      measures: {
        arr: { type: "decimal", display_name: "ARR", format: "currency" },
        mrr: { type: "decimal", display_name: "MRR" },
      },
      dimensions: {
        region: { type: "string", display_name: "Region" },
        segment: { type: "string" },
      },
    },
    orders: {
      measures: { cnt: { type: "bigint" } },
      dimensions: {},
    },
  };

  test("returns only the requested measures and dimensions (flat slice)", () => {
    expect(selectMetricMetadata(all, "revenue", ["arr"], ["region"])).toEqual({
      arr: { type: "decimal", display_name: "ARR", format: "currency" },
      region: { type: "string", display_name: "Region" },
    });
  });

  test("omits requested columns absent from the metadata (degraded/unknown cols)", () => {
    // `mrr` is known; `ebitda` and `country` are not → dropped, not placeheld.
    expect(
      selectMetricMetadata(all, "revenue", ["mrr", "ebitda"], ["country"]),
    ).toEqual({
      mrr: { type: "decimal", display_name: "MRR" },
    });
  });

  test("undefined when no metadata is injected (all absent)", () => {
    expect(
      selectMetricMetadata(undefined, "revenue", ["arr"], ["region"]),
    ).toBeUndefined();
  });

  test("undefined for an unknown metric key", () => {
    expect(
      selectMetricMetadata(all, "nope", ["arr"], undefined),
    ).toBeUndefined();
  });

  test("undefined when none of the requested columns are present (empty slice)", () => {
    expect(
      selectMetricMetadata(all, "revenue", ["unknown"], ["also_unknown"]),
    ).toBeUndefined();
  });

  test("undefined when dimensions is undefined and no measures match", () => {
    expect(
      selectMetricMetadata(all, "orders", ["missing"], undefined),
    ).toBeUndefined();
  });

  test("handles undefined dimensions (measures only)", () => {
    expect(selectMetricMetadata(all, "orders", ["cnt"], undefined)).toEqual({
      cnt: { type: "bigint" },
    });
  });

  test.each(["__proto__", "constructor", "toString", "hasOwnProperty"])(
    "inherited Object.prototype key %j → undefined (own-property lookup)",
    (dangerousKey) => {
      expect(
        selectMetricMetadata(all, dangerousKey, ["arr"], undefined),
      ).toBeUndefined();
    },
  );

  test("does not resolve a requested column to an inherited prototype member", () => {
    // `toString` is an inherited member of the measures object, not an own
    // entry — it must not leak into the slice as a bogus function value.
    expect(
      selectMetricMetadata(all, "revenue", ["toString"], ["hasOwnProperty"]),
    ).toBeUndefined();
  });
});
