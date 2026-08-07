import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
// `quoteFqnForSql` now lives in the shared zod-free leaf alongside the FQN
// grammar (moved so the analytics runtime can reuse it); the describe seam
// imports it from there.
import { quoteFqnForSql } from "../../../../shared/src/schemas/metric-fqn";
import { metricSourceSchema } from "../../../../shared/src/schemas/metric-source";
import { readMetricConfig, resolveMetricConfig } from "../mv-registry/config";
import {
  createWorkspaceDescribeFetcher,
  extractMetricColumns,
  parseDescribeTableExtendedJson,
} from "../mv-registry/describe";
import { generateMetricTypeDeclarations } from "../mv-registry/render-types";
import { syncMetrics } from "../mv-registry/sync";
import type { DatabricksStatementExecutionResponse } from "../types";

/**
 * Build a representative DESCRIBE TABLE EXTENDED ... AS JSON response.
 *
 * The Statement Execution API returns one row, one cell — a JSON string
 * payload. The shape is broadly:
 *
 * ```json
 * {
 *   "table_name": "...",
 *   "columns": [
 *     { "name": "arr", "type": "DECIMAL(38,2)", "is_measure": true, "comment": "..." },
 *     { "name": "region", "type": "STRING", "is_measure": false }
 *   ]
 * }
 * ```
 *
 * Unit tests mock this; live warehouse integration is exercised separately.
 */
function mockDescribeResponse(
  payload: unknown,
): DatabricksStatementExecutionResponse {
  return {
    statement_id: "stmt-mock",
    status: { state: "SUCCEEDED" },
    result: {
      data_array: [[JSON.stringify(payload)]],
    },
  };
}

/**
 * Real Arrow IPC attachment captured live from dogfood:
 *   DESCRIBE TABLE EXTENDED `appkit_demo`.`public`.`revenue_metrics` AS JSON
 * with `format: "ARROW_STREAM", disposition: "INLINE"`. The single DESCRIBE
 * row (one JSON-string cell) is base64 Arrow IPC — the wire shape this fetcher
 * now requests and the normalizer decodes. Used to prove the fetcher →
 * normalizer → parser chain extracts real columns from an attachment-only
 * response (the silent-degrade bug left this unread).
 */
const ARROW_ATTACHMENT_B64 = readFileSync(
  path.join(__dirname, "fixtures", "describe-arrow-attachment.b64"),
  "utf-8",
);

/**
 * Cast helper for fixtures that intentionally violate the config type
 * (invalid executors, unknown fields, legacy shapes, ...).
 */
const resolveUnchecked = (config: unknown) =>
  resolveMetricConfig(config as Parameters<typeof resolveMetricConfig>[0]);

describe("readMetricConfig", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "appkit-metric-typegen-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("returns null when definitions.json is absent", async () => {
    expect(await readMetricConfig(tmpDir)).toBeNull();
  });

  test("ignores a legacy metric.json file (no fallback)", async () => {
    await fs.writeFile(
      path.join(tmpDir, "metric.json"),
      JSON.stringify({
        metricViews: { revenue: { source: "demo.public.revenue" } },
      }),
    );
    expect(await readMetricConfig(tmpDir)).toBeNull();
  });

  test("parses a valid definitions.json", async () => {
    await fs.writeFile(
      path.join(tmpDir, "definitions.json"),
      JSON.stringify({
        metricViews: { revenue: { source: "demo.public.revenue" } },
      }),
    );
    const cfg = await readMetricConfig(tmpDir);
    expect(cfg?.metricViews?.revenue.source).toBe("demo.public.revenue");
  });

  test("throws on malformed JSON", async () => {
    await fs.writeFile(path.join(tmpDir, "definitions.json"), "{not json");
    await expect(readMetricConfig(tmpDir)).rejects.toThrowError(
      /parse definitions\.json/,
    );
  });
});

describe("resolveMetricConfig", () => {
  test("flattens metricViews into a sorted entries list with derived lanes", () => {
    const cfg = {
      metricViews: {
        b_metric: { source: "a.b.c" },
        a_metric: { source: "a.b.d" },
        c_metric: { source: "a.b.e", executor: "user" as const },
      },
    };
    const { entries } = resolveMetricConfig(cfg);
    expect(entries.map((e) => e.key)).toEqual([
      "a_metric",
      "b_metric",
      "c_metric",
    ]);
    expect(entries[0].lane).toBe("sp");
    expect(entries[1].lane).toBe("sp");
    expect(entries[2].lane).toBe("obo");
  });

  test("defaults an absent executor to the sp lane", () => {
    const { entries } = resolveMetricConfig({
      metricViews: { revenue: { source: "a.b.c" } },
    });
    expect(entries).toEqual([{ key: "revenue", source: "a.b.c", lane: "sp" }]);
  });

  test("maps executor 'app_service_principal' to the sp lane", () => {
    const { entries } = resolveMetricConfig({
      metricViews: {
        revenue: { source: "a.b.c", executor: "app_service_principal" },
      },
    });
    expect(entries[0].lane).toBe("sp");
  });

  test("maps executor 'user' to the obo lane", () => {
    const { entries } = resolveMetricConfig({
      metricViews: { revenue: { source: "a.b.c", executor: "user" } },
    });
    expect(entries[0].lane).toBe("obo");
  });

  test("rejects invalid executor values", () => {
    for (const executor of ["sp", "obo", "service_principal", "USER", null]) {
      expect(() =>
        resolveUnchecked({
          metricViews: { revenue: { source: "a.b.c", executor } },
        }),
      ).toThrowError(/Invalid executor/);
    }
  });

  test("rejects unknown entry fields", () => {
    expect(() =>
      resolveUnchecked({
        metricViews: { revenue: { source: "a.b.c", cacheTtl: 60 } },
      }),
    ).toThrowError(/'source' and 'executor' are allowed/);
  });

  test("rejects unknown top-level fields (legacy sp/obo lane shape)", () => {
    expect(() =>
      resolveUnchecked({ sp: { revenue: { source: "a.b.c" } } }),
    ).toThrowError(/Invalid top-level field "sp"/);
    expect(() =>
      resolveUnchecked({ metricViews: {}, unknown: {} }),
    ).toThrowError(/Invalid top-level field "unknown"/);
  });

  test("accepts $schema at the top level", () => {
    const { entries } = resolveMetricConfig({
      $schema:
        "https://databricks.github.io/appkit/schemas/metric-source.schema.json",
      metricViews: { revenue: { source: "a.b.c" } },
    });
    expect(entries).toHaveLength(1);
  });

  test("resolves to no entries when metricViews is absent", () => {
    expect(resolveMetricConfig({}).entries).toEqual([]);
  });

  test("resolves to no entries when metricViews is empty", () => {
    expect(resolveMetricConfig({ metricViews: {} }).entries).toEqual([]);
  });

  test("rejects metricViews: null (only a genuinely-absent field defaults)", () => {
    // The canonical Zod schema rejects null (`.optional()` admits undefined
    // only) — the inline validator must not coalesce null into an empty map.
    expect(() => resolveUnchecked({ metricViews: null })).toThrowError(
      /expected an object map of metric entries/,
    );
  });

  test("rejects a non-object entry", () => {
    expect(() =>
      resolveUnchecked({ metricViews: { revenue: "a.b.c" } }),
    ).toThrowError(/expected an object/);
  });

  test("rejects bad FQN format", () => {
    const cfg = {
      metricViews: { revenue: { source: "not.three.part.parts" } },
    };
    expect(() => resolveMetricConfig(cfg)).toThrowError(/three-part UC FQN/);
  });

  test("rejects a metric key starting with a digit", () => {
    const cfg = { metricViews: { "1revenue": { source: "a.b.c" } } };
    expect(() => resolveMetricConfig(cfg)).toThrowError(/Invalid metric key/);
  });
});

// ── UC-accurate FQN naming validation. The source FQN is validated against
// UC_FQN_PATTERN (single-sourced from the zod-free
// packages/shared/src/schemas/metric-fqn.ts, shared with the canonical Zod
// schema). A hand-rolled segment charset [a-zA-Z0-9_-] would be more
// restrictive than UC; these tests pin the arity/dot/charset rules and the
// UC-legal characters that must be accepted.
describe("resolveMetricConfig — FQN naming (UC-accurate)", () => {
  const sourceOf = (source: string) => ({
    metricViews: { revenue: { source } },
  });

  // ── Arity: exactly three dot-separated parts ───────────────────────────
  test("rejects too few parts, naming the count and the no-dot-in-name rule", () => {
    expect(() => resolveMetricConfig(sourceOf("revenue"))).toThrowError(
      /three-part UC FQN .*\(got 1 dot-separated part\)\. A catalog, schema, or metric view name cannot itself contain a dot\./,
    );
    expect(() => resolveMetricConfig(sourceOf("demo.revenue"))).toThrowError(
      /\(got 2 dot-separated parts\)/,
    );
  });

  test("rejects too many parts — the way a dot inside a name manifests", () => {
    // The dotted source cannot express a dot inside a name: a fourth dot just
    // reads as a fourth segment. The message explains exactly that.
    expect(() =>
      resolveMetricConfig(sourceOf("cat.schema.my.view")),
    ).toThrowError(
      /three-part UC FQN .*\(got 4 dot-separated parts\)\. A catalog, schema, or metric view name cannot itself contain a dot\./,
    );
  });

  // ── Empty parts: leading / trailing / doubled dots ─────────────────────
  test("rejects an empty part with a position-specific message", () => {
    expect(() => resolveMetricConfig(sourceOf(".schema.view"))).toThrowError(
      /the catalog part is empty/,
    );
    expect(() => resolveMetricConfig(sourceOf("cat..view"))).toThrowError(
      /the schema part is empty/,
    );
    expect(() => resolveMetricConfig(sourceOf("cat.schema."))).toThrowError(
      /the metric_view part is empty/,
    );
  });

  // ── Character set: UC-illegal characters, named by segment ─────────────
  test("rejects a space in a part, naming the part and the UC rule", () => {
    expect(() =>
      resolveMetricConfig(sourceOf("cat.schema.my view")),
    ).toThrowError(
      /the metric_view part "my view" contains a character Unity Catalog does not allow in an object name \(no spaces, '\/', or control characters\)\./,
    );
  });

  test("rejects a forward slash and a control character in a part", () => {
    expect(() =>
      resolveMetricConfig(sourceOf("ca/t.schema.view")),
    ).toThrowError(/the catalog part "ca\/t" contains a character/);
    expect(() =>
      resolveMetricConfig(sourceOf("cat.sch\tema.view")),
    ).toThrowError(/the schema part .* contains a character/);
  });

  // ── UC-legal characters a narrow [a-zA-Z0-9_-] regex would reject must be
  // accepted (hyphens, mixed case, non-ASCII). ───────────────────────────
  test("accepts hyphens, mixed case, and non-ASCII names UC permits", () => {
    for (const source of [
      "prod-data.analytics.revenue",
      "Catalog.Schema.RevenueMetrics",
      "café.public.revenue", // accented latin — old regex rejected this
      "main.public.指标", // CJK — old regex rejected this
      "main.public.metrics(v2)", // parentheses — old regex rejected this
    ]) {
      const { entries } = resolveMetricConfig({
        metricViews: { m: { source } },
      });
      expect(entries[0].source).toBe(source);
    }
  });

  test("accepts a previously-rejected character end-to-end (resolve → describe statement quoted)", async () => {
    // Single, focused regression: an accented catalog name is UC-legal in a
    // quoted identifier but the old segment charset [a-zA-Z0-9_-] rejected it.
    // It must now resolve AND quote cleanly in the DESCRIBE statement.
    const source = "café.public.revenue";
    const { entries } = resolveMetricConfig({
      metricViews: { revenue: { source } },
    });
    expect(entries[0].source).toBe(source);

    const statements: Array<Record<string, unknown>> = [];
    const client = {
      statementExecution: {
        executeStatement: async (req: Record<string, unknown>) => {
          statements.push(req);
          return mockDescribeResponse({
            columns: [{ name: "arr", type: "DECIMAL", is_measure: true }],
          });
        },
      },
    } as unknown as Parameters<typeof createWorkspaceDescribeFetcher>[0];

    await createWorkspaceDescribeFetcher(client, "wh-1")(entries[0].source);
    expect(statements[0].statement).toBe(
      "DESCRIBE TABLE EXTENDED `café`.`public`.`revenue` AS JSON",
    );
  });

  // ── Malformed → throw at parse time; well-formed-but-nonexistent → degrade
  // (the degrade path is unchanged — a syntactically valid FQN that the
  // warehouse cannot resolve still flows to DESCRIBE and degrades). ───────
  test("a malformed FQN throws at resolve time (never reaches the warehouse)", () => {
    expect(() =>
      resolveMetricConfig(sourceOf("not.three.part.parts")),
    ).toThrowError(/three-part UC FQN/);
  });

  test("a well-formed-but-nonexistent FQN resolves, then degrades at the warehouse (unchanged)", async () => {
    // Shape-valid, so resolution accepts it...
    const resolution = resolveMetricConfig(
      sourceOf("does_not_exist.nope.ghost"),
    );
    expect(resolution.entries[0].source).toBe("does_not_exist.nope.ghost");

    // ...and the warehouse verdict (FAILED: no such table) degrades it without
    // crashing the pass — exactly the pre-existing degrade behavior.
    const fetcher =
      async (): Promise<DatabricksStatementExecutionResponse> => ({
        statement_id: "stmt-mock",
        status: { state: "FAILED", error: { message: "no such table" } },
      });
    const { schemas, failures } = await syncMetrics(resolution, fetcher);
    expect(schemas[0].degraded).toBe(true);
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toMatch(/no such table/);
  });
});

// ── Input caps (inline-only at v1): the canonical Zod schema does not yet
// carry these caps, so these fixtures deliberately do NOT run through
// metricSourceSchema (they'd pass it) and stay out of the parity suite below.
describe("resolveMetricConfig — input caps", () => {
  const manyViews = (count: number) =>
    Object.fromEntries(
      Array.from({ length: count }, (_, i) => [`m${i}`, { source: "a.b.c" }]),
    );

  test("accepts exactly 200 metricViews entries", () => {
    const { entries } = resolveMetricConfig({ metricViews: manyViews(200) });
    expect(entries).toHaveLength(200);
  });

  test("rejects 201 metricViews entries, naming the limit and the count", () => {
    expect(() =>
      resolveMetricConfig({ metricViews: manyViews(201) }),
    ).toThrowError(/201 metric views exceed the maximum of 200/);
  });

  test("accepts FQN segments of exactly 255 characters (full FQN at the 767 cap)", () => {
    const seg = "a".repeat(255);
    const fqn = `${seg}.${seg}.${seg}`; // 3 × 255 + 2 = 767 — at the cap.
    expect(fqn).toHaveLength(767);
    const { entries } = resolveMetricConfig({
      metricViews: { revenue: { source: fqn } },
    });
    expect(entries[0].source).toBe(fqn);
  });

  test("rejects a 256-character FQN segment, naming the key, segment, and limit", () => {
    const fqn = `${"a".repeat(256)}.b.c`;
    expect(() =>
      resolveMetricConfig({ metricViews: { revenue: { source: fqn } } }),
    ).toThrowError(
      /Invalid metric source for "revenue": the catalog segment is 256 characters, exceeding the maximum of 255/,
    );
  });

  test("rejects a full FQN over 767 characters, naming the key and limit", () => {
    const seg = "a".repeat(300);
    const fqn = `${seg}.${seg}.${seg}`; // 902 — total cap fires before segment caps.
    expect(() =>
      resolveMetricConfig({ metricViews: { revenue: { source: fqn } } }),
    ).toThrowError(
      /Invalid metric source for "revenue": FQN is 902 characters, exceeding the maximum of 767/,
    );
  });
});

// ── Parity: the inline config validation must agree with the canonical
// shared Zod schema (packages/shared/src/schemas/metric-source.ts).
// The FQN naming grammar is now SINGLE-SOURCED: both sides validate against
// UC_FQN_PATTERN from the zod-free packages/shared/src/schemas/metric-fqn.ts
// (the runtime imports the plain value; the Zod schema composes its three-part
// .regex(...) from it). The type-generator still must not pull the shared *Zod*
// schema package into its runtime path (locked dependency-graph ruling), which
// the zod-free module preserves. Entry/top-level allowlists remain hand-mirrored
// inline; this block is the drift alarm for them. TEST-ONLY import of the Zod schema.
//
// Caps divergence: the inline validator enforces v1 input caps (≤200 entries,
// ≤255 per FQN segment, ≤767 full FQN) that the canonical schema does not carry
// yet. Cap fixtures therefore live in the dedicated caps suite above and are
// asserted on the inline side only; do NOT add them here expecting
// metricSourceSchema to reject them.
describe("resolveMetricConfig — parity with shared metricSourceSchema", () => {
  const accepts: Array<{ name: string; config: Record<string, unknown> }> = [
    {
      name: "single entry with default executor",
      config: { metricViews: { revenue: { source: "demo.public.revenue" } } },
    },
    {
      name: "explicit app_service_principal executor",
      config: {
        metricViews: {
          revenue: {
            source: "demo.public.revenue",
            executor: "app_service_principal",
          },
        },
      },
    },
    {
      name: "user executor",
      config: {
        metricViews: {
          customer_metrics: {
            source: "appkit_demo.public.customer_metrics",
            executor: "user",
          },
        },
      },
    },
    {
      name: "$schema plus multiple entries",
      config: {
        $schema:
          "https://databricks.github.io/appkit/schemas/metric-source.schema.json",
        metricViews: {
          a_metric: { source: "a.b.c" },
          b_metric: { source: "a.b.d", executor: "user" },
        },
      },
    },
    { name: "empty config (no metricViews)", config: {} },
    { name: "empty metricViews map", config: { metricViews: {} } },
    // UC-legal characters the OLD [a-zA-Z0-9_-] regex rejected — both the
    // inline validator and the Zod schema must now accept them in lockstep.
    {
      name: "hyphenated catalog (UC-legal)",
      config: { metricViews: { revenue: { source: "prod-data.public.rev" } } },
    },
    {
      name: "non-ASCII metric view name (UC-legal)",
      config: { metricViews: { revenue: { source: "main.public.指标" } } },
    },
  ];

  const rejects: Array<{ name: string; config: Record<string, unknown> }> = [
    {
      name: "metric key starting with a digit",
      config: { metricViews: { "1revenue": { source: "a.b.c" } } },
    },
    {
      name: "non-three-part FQN",
      config: { metricViews: { revenue: { source: "not.three.part.parts" } } },
    },
    {
      name: "UC-illegal character in a part (space)",
      config: { metricViews: { revenue: { source: "a.b.c d" } } },
    },
    {
      name: "invalid executor value",
      config: {
        metricViews: { revenue: { source: "a.b.c", executor: "admin" } },
      },
    },
    {
      name: "unknown entry field",
      config: {
        metricViews: { revenue: { source: "a.b.c", cacheTtl: 60 } },
      },
    },
    {
      name: "unknown top-level field (legacy sp lane shape)",
      config: { sp: { revenue: { source: "a.b.c" } } },
    },
    {
      name: "non-object entry",
      config: { metricViews: { revenue: "a.b.c" } },
    },
    {
      // `.optional()` admits undefined only — null must throw on both sides.
      name: "metricViews: null",
      config: { metricViews: null },
    },
  ];

  for (const fixture of accepts) {
    test(`both accept: ${fixture.name}`, () => {
      expect(metricSourceSchema.safeParse(fixture.config).success).toBe(true);
      expect(() => resolveUnchecked(fixture.config)).not.toThrow();
    });
  }

  for (const fixture of rejects) {
    test(`both reject: ${fixture.name}`, () => {
      expect(metricSourceSchema.safeParse(fixture.config).success).toBe(false);
      expect(() => resolveUnchecked(fixture.config)).toThrow();
    });
  }
});

describe("parseDescribeTableExtendedJson", () => {
  test("parses the JSON payload from the first cell", () => {
    const response = mockDescribeResponse({
      columns: [{ name: "arr", type: "DECIMAL", is_measure: true }],
    });
    const parsed = parseDescribeTableExtendedJson(response);
    expect(parsed).toMatchObject({
      columns: [{ name: "arr", type: "DECIMAL", is_measure: true }],
    });
  });

  test("throws on a FAILED status", () => {
    expect(() =>
      parseDescribeTableExtendedJson({
        statement_id: "x",
        status: { state: "FAILED", error: { message: "no such table" } },
      }),
    ).toThrowError(/no such table/);
  });

  test("throws when the response is empty", () => {
    expect(() =>
      parseDescribeTableExtendedJson({
        statement_id: "x",
        status: { state: "SUCCEEDED" },
        result: { data_array: [] },
      }),
    ).toThrowError(/no rows/);
  });

  test("throws when the cell is not a JSON string", () => {
    expect(() =>
      parseDescribeTableExtendedJson({
        statement_id: "x",
        status: { state: "SUCCEEDED" },
        result: { data_array: [[null]] },
      }),
    ).toThrowError(/JSON string/);
  });
});

// ── Standalone SQL identifier escaper: the injection-safety primitive that
// createWorkspaceDescribeFetcher composes with. Tested directly here,
// independent of FQN naming validation — it must make ANY input it accepts a
// single well-formed backtick-quoted identifier, doubling embedded backticks
// (the only break-out) and refusing control characters/newlines outright.
describe("quoteFqnForSql", () => {
  test("quotes an ordinary three-part identifier unchanged (just wrapped)", () => {
    expect(quoteFqnForSql("catalog.schema.view")).toBe(
      "`catalog`.`schema`.`view`",
    );
  });

  test("preserves the segment charset, incl. underscores and hyphens", () => {
    expect(quoteFqnForSql("prod-data.public_1.revenue_metrics")).toBe(
      "`prod-data`.`public_1`.`revenue_metrics`",
    );
  });

  test("joins an arbitrary number of segments on '.' (1 and 4 parts)", () => {
    expect(quoteFqnForSql("solo")).toBe("`solo`");
    expect(quoteFqnForSql("a.b.c.d")).toBe("`a`.`b`.`c`.`d`");
  });

  test("doubles a backtick inside a segment so it cannot break out", () => {
    // The injection-style payload `a\`b`: a naive `\`${segment}\`` wrap would
    // emit `a`b` — three backticks, closing the identifier early and leaving a
    // bare `b` token. Doubling makes it the single identifier `a``b`.
    expect(quoteFqnForSql("a.b.a`b")).toBe("`a`.`b`.`a``b`");
  });

  test("neutralizes a backtick-led `;DROP` break-out attempt into one identifier", () => {
    // `x\`;DROP TABLE t;--` would, unescaped, close the identifier at the first
    // backtick and append `;DROP TABLE t;--` as live SQL. Doubling the backtick
    // keeps the entire payload trapped inside a single quoted identifier.
    const out = quoteFqnForSql("cat.sch.x`;DROP TABLE t;--");
    expect(out).toBe("`cat`.`sch`.`x``;DROP TABLE t;--`");
    // The dangerous lone backtick is gone: every backtick is now part of a
    // balanced pair, so the identifier is well-formed and self-contained.
    expect(out.split("`").length - 1).toBe(8); // 2 wraps × 3 segs + 1 doubled
    expect(out.endsWith("`")).toBe(true);
  });

  test("doubles every backtick when a segment contains several", () => {
    expect(quoteFqnForSql("a.b.`c`d`")).toBe("`a`.`b`.```c``d```");
  });

  test("rejects a segment containing a newline, naming the problem", () => {
    expect(() => quoteFqnForSql("a.b.c\nDROP")).toThrowError(
      /control character or newline/,
    );
  });

  test("rejects a carriage return and a tab too", () => {
    expect(() => quoteFqnForSql("a.b.c\rd")).toThrowError(
      /control character or newline/,
    );
    expect(() => quoteFqnForSql("a.b.c\td")).toThrowError(
      /control character or newline/,
    );
  });

  test("rejects a NUL byte (C0 control)", () => {
    expect(() => quoteFqnForSql("a.b.c\x00d")).toThrowError(
      /control character or newline/,
    );
  });
});

// ── DESCRIBE statement construction: every FQN segment is backtick-quoted.
// The segment charset ([a-zA-Z0-9_][a-zA-Z0-9_-]*) cannot contain backticks,
// so the quoting cannot be escaped from — and the one SQL metacharacter the
// charset does allow (`-`, which unquoted can open a `--` line comment) is
// neutralized inside the quotes.
describe("createWorkspaceDescribeFetcher", () => {
  /** Stub WorkspaceClient capturing executeStatement requests. */
  function stubClient(payload: unknown = { columns: [] }) {
    const statements: Array<Record<string, unknown>> = [];
    const client = {
      statementExecution: {
        executeStatement: async (req: Record<string, unknown>) => {
          statements.push(req);
          return mockDescribeResponse(payload);
        },
      },
    } as unknown as Parameters<typeof createWorkspaceDescribeFetcher>[0];
    return { client, statements };
  }

  test("emits a backtick-quoted three-part FQN with warehouse id and wait timeout", async () => {
    const { client, statements } = stubClient();
    const fetcher = createWorkspaceDescribeFetcher(client, "wh-1");

    await fetcher("demo.sales.revenue");

    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatchObject({
      statement: "DESCRIBE TABLE EXTENDED `demo`.`sales`.`revenue` AS JSON",
      warehouse_id: "wh-1",
      wait_timeout: "30s",
      // describeAdaptive tries JSON_ARRAY first (standard DBSQL); it falls back
      // to ARROW_STREAM only if the warehouse rejects that format.
      format: "JSON_ARRAY",
      disposition: "INLINE",
    });
  });

  test("decodes an Arrow attachment-only response into parseable columns (fetcher → normalizer → parser)", async () => {
    // The warehouse answers ARROW_STREAM/INLINE: rows arrive as a base64 Arrow
    // IPC attachment with `data_array` undefined. Before the normalizer was
    // wired in, parseDescribeTableExtendedJson read this as "no rows" and the
    // metric shipped degraded. Now the fetcher pipes the response through
    // normalizeResultRows, so the real describe doc is recovered end-to-end.
    const statements: Array<Record<string, unknown>> = [];
    const client = {
      statementExecution: {
        executeStatement: async (req: Record<string, unknown>) => {
          statements.push(req);
          return {
            statement_id: "stmt-arrow",
            status: { state: "SUCCEEDED" },
            manifest: { format: "ARROW_STREAM" },
            // Only an attachment — no data_array (the bug's trigger condition).
            result: { attachment: ARROW_ATTACHMENT_B64 },
          } as DatabricksStatementExecutionResponse;
        },
      },
    } as unknown as Parameters<typeof createWorkspaceDescribeFetcher>[0];

    const fetcher = createWorkspaceDescribeFetcher(client, "wh-1");
    const response = await fetcher("appkit_demo.public.revenue_metrics");

    // The fetcher decoded the attachment: rows are now readable.
    expect(response.result?.data_array).toBeDefined();
    const parsed = parseDescribeTableExtendedJson(response);
    const cols = extractMetricColumns(parsed);
    // The real revenue_metrics describe doc carries measures and dimensions.
    expect(cols.length).toBeGreaterThan(0);
    expect(cols.some((c) => c.isMeasure)).toBe(true);
    expect(cols.some((c) => !c.isMeasure)).toBe(true);
  });

  test("a hyphenated FQN round-trips: validated by resolveMetricConfig, quoted in the statement, response parsed", async () => {
    // Hyphenated catalogs are valid per the shared source regex; unquoted
    // they would be a SQL syntax error against a real warehouse.
    const { entries } = resolveMetricConfig({
      metricViews: { revenue: { source: "prod-data.analytics.revenue" } },
    });
    expect(entries[0].source).toBe("prod-data.analytics.revenue");

    const { client, statements } = stubClient({
      columns: [{ name: "arr", type: "DECIMAL", is_measure: true }],
    });
    const fetcher = createWorkspaceDescribeFetcher(client, "wh-1");

    const response = await fetcher(entries[0].source);

    expect(statements[0].statement).toBe(
      "DESCRIBE TABLE EXTENDED `prod-data`.`analytics`.`revenue` AS JSON",
    );
    const cols = extractMetricColumns(parseDescribeTableExtendedJson(response));
    expect(cols).toHaveLength(1);
    expect(cols[0]).toMatchObject({
      name: "arr",
      type: "DECIMAL",
      isMeasure: true,
    });
  });

  test("a segment containing `--` is quoted so the comment introducer is neutralized", async () => {
    const { client, statements } = stubClient();
    const fetcher = createWorkspaceDescribeFetcher(client, "wh-1");

    await fetcher("a.b.c--x");

    // `--` sits inside backticks — an identifier character sequence, not a
    // line comment that would truncate ` AS JSON` off the statement.
    expect(statements[0].statement).toBe(
      "DESCRIBE TABLE EXTENDED `a`.`b`.`c--x` AS JSON",
    );
    expect(statements[0].statement).toContain("`c--x`");
  });

  test("rejects an FQN that fails validation without issuing a statement", async () => {
    const { client, statements } = stubClient();
    const fetcher = createWorkspaceDescribeFetcher(client, "wh-1");

    // Wrong arity and UC-illegal characters (a space here) both fail the
    // defense-in-depth re-validation at the fetcher seam — no statement issued.
    await expect(fetcher("not.three.part.parts")).rejects.toThrowError(
      /three-part UC FQN/,
    );
    await expect(fetcher("a.b.c d")).rejects.toThrowError(/three-part UC FQN/);
    expect(statements).toHaveLength(0);
  });

  test("a backtick-bearing FQN is now accepted and safely quoted (UC permits it, quoting doubles it)", async () => {
    // A narrow segment charset ([a-zA-Z0-9_-]) would reject a backtick outright.
    // UC actually permits a backtick inside a quoted name, and quoteFqnForSql
    // makes it injection-safe by doubling it. So naming validation accepts it
    // and the statement quotes it as a single identifier rather than refusing
    // the FQN.
    const { client, statements } = stubClient();
    const fetcher = createWorkspaceDescribeFetcher(client, "wh-1");

    await fetcher("a.b.a`c");

    expect(statements).toHaveLength(1);
    expect(statements[0].statement).toBe(
      "DESCRIBE TABLE EXTENDED `a`.`b`.`a``c` AS JSON",
    );
  });
});

describe("extractMetricColumns", () => {
  test("extracts measures and dimensions from the standard shape", () => {
    const cols = extractMetricColumns({
      columns: [
        {
          name: "arr",
          type: "DECIMAL(38,2)",
          is_measure: true,
          comment: "Annual recurring revenue",
        },
        { name: "region", type: "STRING", is_measure: false },
      ],
    });
    expect(cols).toHaveLength(2);
    expect(cols[0]).toMatchObject({
      name: "arr",
      type: "DECIMAL(38,2)",
      isMeasure: true,
      description: "Annual recurring revenue",
    });
    expect(cols[1]).toMatchObject({
      name: "region",
      type: "STRING",
      isMeasure: false,
    });
  });

  test("falls back to schema.fields shape", () => {
    const cols = extractMetricColumns({
      schema: {
        fields: [
          {
            name: "mrr",
            type: { name: "DOUBLE" },
            metadata: { is_measure: true },
          },
        ],
      },
    });
    expect(cols).toHaveLength(1);
    expect(cols[0]).toMatchObject({
      name: "mrr",
      type: "DOUBLE",
      isMeasure: true,
    });
  });

  test("returns empty array on unrecognized shape", () => {
    expect(extractMetricColumns({ unrelated: true })).toEqual([]);
  });

  // ── time-typed dimensions ──────────────────────────────────────────────
  test("infers all 7 standard grains for a TIMESTAMP dimension", () => {
    const cols = extractMetricColumns({
      columns: [
        { name: "created_at", type: "TIMESTAMP", is_measure: false },
        { name: "region", type: "STRING", is_measure: false },
      ],
    });
    expect(cols).toHaveLength(2);
    expect(cols[0]).toMatchObject({
      name: "created_at",
      isMeasure: false,
      timeGrains: ["day", "hour", "minute", "month", "quarter", "week", "year"],
    });
    // Non-time dim has no timeGrains key.
    expect(cols[1].timeGrains).toBeUndefined();
  });

  test("infers 5 standard grains (no sub-day) for a DATE dimension", () => {
    const cols = extractMetricColumns({
      columns: [{ name: "billing_date", type: "DATE", is_measure: false }],
    });
    expect(cols[0].timeGrains).toEqual([
      "day",
      "month",
      "quarter",
      "week",
      "year",
    ]);
  });

  test("recognizes TIMESTAMP_LTZ and TIMESTAMP_NTZ aliases", () => {
    const cols = extractMetricColumns({
      columns: [
        { name: "ts_ltz", type: "TIMESTAMP_LTZ", is_measure: false },
        { name: "ts_ntz", type: "TIMESTAMP_NTZ", is_measure: false },
      ],
    });
    expect(cols[0].timeGrains).toEqual([
      "day",
      "hour",
      "minute",
      "month",
      "quarter",
      "week",
      "year",
    ]);
    expect(cols[1].timeGrains).toEqual([
      "day",
      "hour",
      "minute",
      "month",
      "quarter",
      "week",
      "year",
    ]);
  });

  test("type matching is case-insensitive", () => {
    const cols = extractMetricColumns({
      columns: [
        { name: "a", type: "timestamp", is_measure: false },
        { name: "b", type: "Timestamp", is_measure: false },
        { name: "c", type: "DATE", is_measure: false },
        { name: "d", type: "date", is_measure: false },
      ],
    });
    expect(cols[0].timeGrains?.length).toBe(7);
    expect(cols[1].timeGrains?.length).toBe(7);
    expect(cols[2].timeGrains?.length).toBe(5);
    expect(cols[3].timeGrains?.length).toBe(5);
  });

  test("strips parameterized type suffixes like TIMESTAMP(6)", () => {
    const cols = extractMetricColumns({
      columns: [{ name: "ts", type: "TIMESTAMP(6)", is_measure: false }],
    });
    expect(cols[0].timeGrains?.length).toBe(7);
  });

  test("does not infer grains for non-temporal types", () => {
    const cols = extractMetricColumns({
      columns: [
        { name: "id", type: "BIGINT", is_measure: false },
        { name: "name", type: "STRING", is_measure: false },
        { name: "amount", type: "DECIMAL(38,2)", is_measure: false },
      ],
    });
    for (const col of cols) {
      expect(col.timeGrains).toBeUndefined();
    }
  });

  test("does not infer grains on measures even if their type is TIMESTAMP", () => {
    // Measures are aggregated, never grouped on — grain inference is
    // dimension-only. Defends against an unusual MEASURE() expression
    // resolving to a temporal type.
    const cols = extractMetricColumns({
      columns: [{ name: "last_event_at", type: "TIMESTAMP", is_measure: true }],
    });
    expect(cols[0].timeGrains).toBeUndefined();
  });
});

describe("syncMetrics", () => {
  test("returns one schema per resolved entry, columns split by measure flag", async () => {
    const resolution = resolveMetricConfig({
      metricViews: { revenue: { source: "demo.public.revenue" } },
    });

    const fetcher = async () =>
      mockDescribeResponse({
        columns: [
          { name: "arr", type: "DECIMAL(38,2)", is_measure: true },
          { name: "mrr", type: "DECIMAL(38,2)", is_measure: true },
          { name: "region", type: "STRING", is_measure: false },
        ],
      });

    const { schemas } = await syncMetrics(resolution, fetcher);
    expect(schemas).toHaveLength(1);
    const [schema] = schemas;
    expect(schema.key).toBe("revenue");
    expect(schema.measures.map((m) => m.name)).toEqual(["arr", "mrr"]);
    expect(schema.dimensions.map((d) => d.name)).toEqual(["region"]);
    // A successful parse is a real schema — never marked degraded.
    expect(schema.degraded).toBeUndefined();
  });

  test("falls back to empty columns when DESCRIBE throws (does not crash typegen)", async () => {
    const resolution = resolveMetricConfig({
      metricViews: { revenue: { source: "demo.public.revenue" } },
    });

    const fetcher = async () => {
      throw new Error("warehouse unreachable");
    };

    const { schemas, failures } = await syncMetrics(resolution, fetcher);
    expect(schemas[0].measures).toEqual([]);
    expect(schemas[0].dimensions).toEqual([]);
    // Both flags, orthogonally: the failure drives loud reporting, the
    // degraded marker drives permissive rendering (the schema is unknown).
    expect(schemas[0].degraded).toBe(true);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      key: "revenue",
      source: "demo.public.revenue",
      // A throw with no recognizable connectivity signal is treated as
      // deterministic (transient: false) — surfaced, not silently retried. The
      // point of this test is that it is RECORDED, never an uncaught crash.
      transient: false,
    });
    expect(failures[0].reason).toMatch(/warehouse unreachable/);
  });

  test("a multi-chunk (truncated) DESCRIBE surfaces as a loud failure, not a crash (fetcher → normalizer → syncMetrics)", async () => {
    // End-to-end loudness check for the truncation guard. The warehouse paginates
    // the DESCRIBE result (sets next_chunk_index on the first chunk); the fetcher
    // pipes the response through normalizeResultRows, which THROWS rather than
    // emit partial types. That throw must be caught inside describeOne and
    // recorded as a MetricSyncFailure — never an uncaught crash that aborts the
    // whole generation pass.
    const resolution = resolveMetricConfig({
      metricViews: { revenue: { source: "demo.public.revenue" } },
    });
    const client = {
      statementExecution: {
        executeStatement: async () =>
          ({
            statement_id: "stmt-chunked",
            status: { state: "SUCCEEDED" },
            manifest: { format: "ARROW_STREAM" },
            result: {
              attachment: ARROW_ATTACHMENT_B64,
              next_chunk_index: 1,
            },
          }) as DatabricksStatementExecutionResponse,
      },
    } as unknown as Parameters<typeof createWorkspaceDescribeFetcher>[0];
    const fetcher = createWorkspaceDescribeFetcher(client, "wh-1");

    // The pass resolves (no crash) and records the truncation loudly.
    const { schemas, failures } = await syncMetrics(resolution, fetcher);
    expect(schemas[0].degraded).toBe(true);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      key: "revenue",
      source: "demo.public.revenue",
      // Truncation is deterministic — re-describing the unchanged entry yields
      // the same multi-chunk result — so it is non-transient (sticky/fatal),
      // never a retryable blip. The point of the test: RECORDED, not a crash.
      transient: false,
    });
    expect(failures[0].reason).toMatch(/multi-chunk/i);
  });
});

// ── D′ transience classification: every failure says whether retrying the
// unchanged entry can succeed. ONLY recognized connectivity errors are
// transient (self-converge, retry next pass); everything else — deterministic
// warehouse answers (FAILED, zero rows, unparseable payload, zero columns), the
// truncation guard, AND unrecognized throws — is non-transient and surfaces as
// a build failure, matching the query path's pessimistic default.
describe("syncMetrics — failure transience (D′)", () => {
  const singleEntryResolution = () =>
    resolveMetricConfig({
      metricViews: { revenue: { source: "demo.public.revenue" } },
    });

  test("a connectivity-flavored rejected fetch is transient", async () => {
    // "socket hang up" matches isConnectivityError — a genuine transport blip,
    // so it stays transient (retry next pass). A throw WITHOUT a connectivity
    // signal is deterministic; see the non-transient cases below.
    const fetcher = async (): Promise<DatabricksStatementExecutionResponse> => {
      throw new Error("socket hang up");
    };
    const { failures } = await syncMetrics(singleEntryResolution(), fetcher);
    expect(failures).toHaveLength(1);
    expect(failures[0].transient).toBe(true);
  });

  test("a connectivity error surfaced by code is transient", async () => {
    const fetcher = async (): Promise<DatabricksStatementExecutionResponse> => {
      const err = new Error("connect ECONNREFUSED 10.0.0.1:443") as Error & {
        code?: string;
      };
      err.code = "ECONNREFUSED";
      throw err;
    };
    const { failures } = await syncMetrics(singleEntryResolution(), fetcher);
    expect(failures).toHaveLength(1);
    expect(failures[0].transient).toBe(true);
  });

  test("an auth failure is non-transient (deterministic — must surface)", async () => {
    // A 403 / permission error is a real misconfiguration, not a blip: it must
    // surface (and fail the build via the caller), never retry forever.
    const fetcher = async (): Promise<DatabricksStatementExecutionResponse> => {
      const err = new Error(
        "PERMISSION_DENIED: cannot access metric view",
      ) as Error & { status?: number };
      err.status = 403;
      throw err;
    };
    const { failures } = await syncMetrics(singleEntryResolution(), fetcher);
    expect(failures).toHaveLength(1);
    expect(failures[0].transient).toBe(false);
  });

  test.each<[string, DatabricksStatementExecutionResponse]>([
    [
      "a FAILED statement",
      {
        statement_id: "stmt-mock",
        status: { state: "FAILED", error: { message: "no such table" } },
      },
    ],
    [
      "a SUCCEEDED statement with zero rows",
      {
        statement_id: "stmt-mock",
        status: { state: "SUCCEEDED" },
        result: { data_array: [] },
      },
    ],
    [
      "an unparseable payload",
      {
        statement_id: "stmt-mock",
        status: { state: "SUCCEEDED" },
        result: { data_array: [["{not json"]] },
      },
    ],
    ["zero extracted columns", mockDescribeResponse({ unrelated: true })],
  ])("%s is non-transient (deterministic)", async (_label, response) => {
    const fetcher = async () => response;
    const { failures } = await syncMetrics(singleEntryResolution(), fetcher);
    expect(failures).toHaveLength(1);
    expect(failures[0].transient).toBe(false);
  });

  test("a defensive rejected settlement is non-transient (unknown cause — surface, don't loop)", async () => {
    // Same poisoned-response trick as the scheduling suite: blow up after
    // the fetch try/catch so the settlement itself rejects. An unknown internal
    // failure carries no connectivity signal, so it is surfaced (deterministic)
    // rather than retried forever — the pessimistic default matching the query path.
    const poisoned = new Proxy({} as DatabricksStatementExecutionResponse, {
      get(_target, prop) {
        if (prop === "then") {
          return undefined; // keep the object await-able
        }
        throw new Error("poisoned response object");
      },
    });
    const fetcher = async () => poisoned;
    const { failures } = await syncMetrics(singleEntryResolution(), fetcher);
    expect(failures).toHaveLength(1);
    expect(failures[0].transient).toBe(false);
  });
});

// ── Parity with the query path's state machine (query-registry): FAILED →
// genuine error, SUCCEEDED → proceed, anything else (PENDING/RUNNING) →
// degraded, never an error. A stopped/cold warehouse that outlives the
// DESCRIBE's `wait_timeout` returns a non-terminal state with no rows —
// previously misclassified as the "returned no rows" wrong-FQN failure.
describe("syncMetrics — DESCRIBE state classification", () => {
  const singleEntryResolution = () =>
    resolveMetricConfig({
      metricViews: { revenue: { source: "demo.public.revenue" } },
    });

  for (const state of ["PENDING", "RUNNING"] as const) {
    test(`a non-terminal ${state} response degrades the schema without recording a failure`, async () => {
      const fetcher =
        async (): Promise<DatabricksStatementExecutionResponse> => ({
          statement_id: "stmt-mock",
          status: { state },
        });

      const { schemas, failures } = await syncMetrics(
        singleEntryResolution(),
        fetcher,
      );
      expect(failures).toEqual([]);
      expect(schemas).toHaveLength(1);
      expect(schemas[0]).toMatchObject({
        key: "revenue",
        source: "demo.public.revenue",
        lane: "sp",
        measures: [],
        dimensions: [],
        degraded: true,
      });
    });
  }

  test("a FAILED response stays a genuine failure (and its schema is degraded)", async () => {
    const fetcher =
      async (): Promise<DatabricksStatementExecutionResponse> => ({
        statement_id: "stmt-mock",
        status: { state: "FAILED", error: { message: "no such table" } },
      });

    const { schemas, failures } = await syncMetrics(
      singleEntryResolution(),
      fetcher,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toMatch(/no such table/);
    expect(schemas[0].degraded).toBe(true);
  });

  test("a SUCCEEDED response with zero rows stays the wrong-FQN failure", async () => {
    // Non-terminal states are classified before parsing, so "returned no
    // rows" is reserved for a statement that genuinely completed empty — a
    // wrong FQN, not warehouse readiness.
    const fetcher =
      async (): Promise<DatabricksStatementExecutionResponse> => ({
        statement_id: "stmt-mock",
        status: { state: "SUCCEEDED" },
        result: { data_array: [] },
      });

    const { schemas, failures } = await syncMetrics(
      singleEntryResolution(),
      fetcher,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toMatch(/returned no rows/);
    expect(failures[0].reason).toMatch(/Verify the FQN/);
    expect(schemas[0].degraded).toBe(true);
  });

  test("a SUCCEEDED response yielding zero extracted columns stays a failure with a degraded schema", async () => {
    const fetcher = async () => mockDescribeResponse({ unrelated: true });

    const { schemas, failures } = await syncMetrics(
      singleEntryResolution(),
      fetcher,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toMatch(/zero columns/);
    expect(schemas[0].degraded).toBe(true);
  });

  test("a confirmed-empty view (SUCCEEDED, dimensions only) is NOT degraded", async () => {
    const resolution = resolveMetricConfig({
      metricViews: { dims_only: { source: "demo.public.dims_only" } },
    });

    const fetcher = async () =>
      mockDescribeResponse({
        columns: [{ name: "region", type: "STRING", is_measure: false }],
      });

    const { schemas, failures } = await syncMetrics(resolution, fetcher);
    expect(failures).toEqual([]);
    expect(schemas[0].degraded).toBeUndefined();
    expect(schemas[0].measures).toEqual([]);
    expect(schemas[0].dimensions.map((d) => d.name)).toEqual(["region"]);
  });
});

// ── Bounded-concurrency scheduling (parity with query-registry's chunked
// DESCRIBE batching): entries run in waves of at most 10 via
// Promise.allSettled, the next wave starting only once the previous one has
// fully settled, and results are reassembled into config order by entry
// index. Per-entry classification semantics are unchanged — only the
// scheduling moved from a sequential loop to chunks.
describe("syncMetrics — bounded-concurrency scheduling", () => {
  /** Manually-resolvable gate for controlling fetcher completion order. */
  function gate() {
    let open: () => void = () => {};
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { opened, open };
  }

  /** Drain microtasks + one macrotask so settled fetches fully propagate. */
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  /** Build a resolution with `count` entries m01, m02, ... (config order). */
  function manyEntries(count: number) {
    const keys = Array.from(
      { length: count },
      (_, i) => `m${String(i + 1).padStart(2, "0")}`,
    );
    const resolution = resolveMetricConfig({
      metricViews: Object.fromEntries(
        keys.map((key) => [key, { source: `demo.public.${key}` }]),
      ),
    });
    // Precondition: resolution preserves the sorted key order.
    expect(resolution.entries.map((e) => e.key)).toEqual(keys);
    return { keys, resolution };
  }

  const keyOf = (fqn: string) => fqn.split(".")[2];

  test("schemas come back in config order even when DESCRIBEs resolve out of order", async () => {
    const { keys, resolution } = manyEntries(12);

    const gates = new Map<string, ReturnType<typeof gate>>();
    const fetcher = async (fqn: string) => {
      const g = gate();
      gates.set(keyOf(fqn), g);
      await g.opened;
      return mockDescribeResponse({
        columns: [
          { name: `${keyOf(fqn)}_total`, type: "BIGINT", is_measure: true },
        ],
      });
    };

    const resultPromise = syncMetrics(resolution, fetcher);

    // Wave 1 (first 10 entries) is in flight; release it back-to-front so
    // later entries complete before earlier ones.
    await flush();
    expect([...gates.keys()]).toEqual(keys.slice(0, 10));
    for (const key of [...keys.slice(0, 10)].reverse()) {
      gates.get(key)?.open();
      await flush(); // let this fetch fully settle before releasing the next
    }

    // Wave 2 (the partial final slice) — release back-to-front too.
    await flush();
    expect([...gates.keys()].slice(10)).toEqual(keys.slice(10));
    for (const key of [...keys.slice(10)].reverse()) {
      gates.get(key)?.open();
      await flush();
    }

    const { schemas, failures } = await resultPromise;
    expect(failures).toEqual([]);
    // Output order equals config order, not completion order.
    expect(schemas.map((s) => s.key)).toEqual(keys);
    // Each slot carries its own entry's schema, not merely the right key.
    expect(schemas.map((s) => s.measures[0]?.name)).toEqual(
      keys.map((key) => `${key}_total`),
    );
  });

  test("in-flight DESCRIBEs are capped at 10; a second wave starts only after the first settles", async () => {
    const { keys, resolution } = manyEntries(12);

    let inFlight = 0;
    let maxInFlight = 0;
    const started: string[] = [];
    const gates: Array<ReturnType<typeof gate>> = [];

    const fetcher = async (fqn: string) => {
      started.push(keyOf(fqn));
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const g = gate();
      gates.push(g);
      try {
        await g.opened;
        return mockDescribeResponse({
          columns: [{ name: "total", type: "BIGINT", is_measure: true }],
        });
      } finally {
        inFlight--;
      }
    };

    const resultPromise = syncMetrics(resolution, fetcher);

    // All 10 wave-1 gates held: calls 11-12 must NOT have started yet.
    await flush();
    await flush();
    expect(started).toEqual(keys.slice(0, 10));
    expect(inFlight).toBe(10);

    // Release wave 1 → only then does wave 2 (the partial slice) start.
    for (const g of gates.slice(0, 10)) {
      g.open();
    }
    await flush();
    expect(started).toEqual(keys);

    for (const g of gates.slice(10)) {
      g.open();
    }
    const { schemas, failures } = await resultPromise;

    expect(failures).toEqual([]);
    expect(schemas).toHaveLength(12);
    // The full wave ran in parallel, but never beyond the bound.
    expect(maxInFlight).toBe(10);
  });

  test("one entry's rejection or non-terminal state never affects its siblings", async () => {
    const { keys, resolution } = manyEntries(12);
    const rejecting = new Set(["m02", "m06", "m11"]);
    const nonTerminal = "m04";

    const fetcher = async (
      fqn: string,
    ): Promise<DatabricksStatementExecutionResponse> => {
      const key = keyOf(fqn);
      if (rejecting.has(key)) {
        throw new Error(`boom ${key}`);
      }
      if (key === nonTerminal) {
        return { statement_id: "stmt-mock", status: { state: "PENDING" } };
      }
      return mockDescribeResponse({
        columns: [
          { name: `${key}_total`, type: "BIGINT", is_measure: true },
          { name: "region", type: "STRING", is_measure: false },
        ],
      });
    };

    const { schemas, failures } = await syncMetrics(resolution, fetcher);

    // Order preserved across the mixed batch.
    expect(schemas.map((s) => s.key)).toEqual(keys);

    // Rejected entries land in `failures` (stable entry order) AND are
    // degraded — the failure matrix is unchanged by chunking.
    expect(failures.map((f) => f.key)).toEqual(["m02", "m06", "m11"]);
    for (const failure of failures) {
      expect(failure.source).toBe(`demo.public.${failure.key}`);
      expect(failure.reason).toBe(
        `DESCRIBE TABLE EXTENDED failed: boom ${failure.key}`,
      );
    }

    for (const schema of schemas) {
      if (rejecting.has(schema.key) || schema.key === nonTerminal) {
        // Degraded: empty allowlists drive permissive rendering downstream.
        expect(schema.degraded).toBe(true);
        expect(schema.measures).toEqual([]);
        expect(schema.dimensions).toEqual([]);
      } else {
        // Siblings keep their real DESCRIBE results.
        expect(schema.degraded).toBeUndefined();
        expect(schema.measures.map((m) => m.name)).toEqual([
          `${schema.key}_total`,
        ]);
        expect(schema.dimensions.map((d) => d.name)).toEqual(["region"]);
      }
    }
  });

  test("a per-entry helper throw (poisoned response object) degrades only that entry", async () => {
    // Fetcher rejections are caught inside the per-entry helper, so a
    // rejected settlement is normally impossible. Force one anyway: a
    // response whose property access throws blows up AFTER the fetch
    // try/catch, rejecting the helper's promise — the defensive
    // rejected-settlement branch must contain it to this entry alone.
    const { keys, resolution } = manyEntries(3);

    const poisoned = new Proxy({} as DatabricksStatementExecutionResponse, {
      get(_target, prop) {
        if (prop === "then") {
          return undefined; // keep the object await-able
        }
        throw new Error("poisoned response object");
      },
    });

    const fetcher = async (fqn: string) =>
      keyOf(fqn) === "m02"
        ? poisoned
        : mockDescribeResponse({
            columns: [{ name: "total", type: "BIGINT", is_measure: true }],
          });

    const { schemas, failures } = await syncMetrics(resolution, fetcher);

    expect(schemas.map((s) => s.key)).toEqual(keys);
    expect(schemas[0].degraded).toBeUndefined();
    expect(schemas[1].degraded).toBe(true);
    expect(schemas[2].degraded).toBeUndefined();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      key: "m02",
      source: "demo.public.m02",
    });
    expect(failures[0].reason).toMatch(/poisoned response object/);
  });
});

describe("generateMetricTypeDeclarations — snapshot", () => {
  test("emits a stable MetricRegistry augmentation for a mixed sp + obo input", async () => {
    const resolution = resolveMetricConfig({
      metricViews: {
        revenue: { source: "appkit_demo.public.revenue_metrics" },
        customer_metrics: {
          source: "appkit_demo.public.customer_metrics",
          executor: "user",
        },
      },
    });

    const fetcher = async (fqn: string) =>
      fqn.endsWith("revenue_metrics")
        ? mockDescribeResponse({
            columns: [
              {
                name: "arr",
                type: "DECIMAL(38,2)",
                is_measure: true,
                display_name: "Annual Recurring Revenue",
                format: "$#,##0.00",
                comment: "Annual recurring revenue",
              },
              {
                name: "mrr",
                type: "DECIMAL(38,2)",
                is_measure: true,
                comment: "Monthly recurring revenue",
              },
              { name: "region", type: "STRING", is_measure: false },
              { name: "created_at", type: "TIMESTAMP", is_measure: false },
            ],
          })
        : mockDescribeResponse({
            columns: [
              {
                name: "churn_rate",
                type: "DOUBLE",
                is_measure: true,
                display_name: "Churn Rate",
                format: "0.0%",
              },
              { name: "csm_email", type: "STRING", is_measure: false },
              { name: "billing_date", type: "DATE", is_measure: false },
            ],
          });

    const { schemas } = await syncMetrics(resolution, fetcher);
    const output = generateMetricTypeDeclarations(schemas);
    expect(output).toMatchSnapshot();

    // Sanity assertions in addition to the snapshot, so future drift surfaces
    // even when snapshots are blindly updated. The executor→lane derivation
    // must hold end-to-end: default → sp, "user" → obo.
    expect(output).toContain('lane: "sp"');
    expect(output).toContain('lane: "obo"');
    expect(output).toContain('format: "$#,##0.00"');
    expect(output).toContain('format: "0.0%"');
    // Metric queries use the JSON_ARRAY wire contract: scalar cells arrive as
    // strings and every selected column may be SQL NULL. Generated row values
    // must describe that runtime shape rather than claiming JS numbers.
    expect(output).toContain('"arr": string | null');
    expect(output).toContain('"churn_rate": string | null');
    expect(output).not.toContain('"arr": number');
  });

  test("emits an empty MetricRegistry interface when no metrics are registered", () => {
    const output = generateMetricTypeDeclarations([]);
    expect(output).toMatchSnapshot();
  });

  // ── Degraded-open rendering: a degraded entry opens up (string unions,
  // permissive row) while a confirmed-empty entry keeps accurate `never`
  // unions — the two must never be conflated.
  test("emits permissive types for a degraded entry and accurate empty unions for a confirmed-empty entry", async () => {
    const resolution = resolveMetricConfig({
      metricViews: {
        cold_metric: { source: "appkit_demo.public.cold_metric" },
        dims_only: {
          source: "appkit_demo.public.dims_only",
          executor: "user",
        },
      },
    });

    const fetcher = async (
      fqn: string,
    ): Promise<DatabricksStatementExecutionResponse> =>
      fqn.endsWith("cold_metric")
        ? // Stopped/cold warehouse: wait_timeout elapsed → non-terminal, no rows.
          { statement_id: "stmt-mock", status: { state: "PENDING" } }
        : // Genuinely measure-less view: SUCCEEDED with dimension columns only.
          mockDescribeResponse({
            columns: [{ name: "region", type: "STRING", is_measure: false }],
          });

    const { schemas, failures } = await syncMetrics(resolution, fetcher);
    expect(failures).toEqual([]);
    const output = generateMetricTypeDeclarations(schemas);
    expect(output).toMatchSnapshot();

    // Sanity assertions in addition to the snapshot, so future drift surfaces
    // even when snapshots are blindly updated. Degraded entry → permissive:
    // unions accept any string, row contributions are Record<string, unknown>.
    expect(output).toContain("measureKeys: string");
    expect(output).toContain("dimensionKeys: string");
    expect(output).toContain("timeGrains: string");
    expect(output).toContain("measures: Record<string, unknown>");
    expect(output).toContain("dimensions: Record<string, unknown>");
    // Confirmed-empty entry → accurate: zero measures stay `never`-style.
    expect(output).toContain("measureKeys: never");
    expect(output).toContain('dimensionKeys: "region"');
    expect(output).toContain("measures: Record<string, never>");
  });

  // ── time-typed dim + multiple non-time dims fixture ──────────────────
  test("emits TimeGrain<K> union for a metric view with time-typed + regular dimensions", async () => {
    const resolution = resolveMetricConfig({
      metricViews: {
        revenue: { source: "appkit_demo.public.revenue_metrics_v2" },
      },
    });

    const fetcher = async () =>
      mockDescribeResponse({
        columns: [
          {
            name: "arr",
            type: "DECIMAL(38,2)",
            is_measure: true,
            comment: "Annual recurring revenue",
          },
          { name: "created_at", type: "TIMESTAMP", is_measure: false },
          { name: "region", type: "STRING", is_measure: false },
          { name: "segment", type: "STRING", is_measure: false },
        ],
      });

    const { schemas } = await syncMetrics(resolution, fetcher);
    const output = generateMetricTypeDeclarations(schemas);
    expect(output).toMatchSnapshot();

    // Sanity assertions in addition to the snapshot, so future drift surfaces
    // even when snapshots are blindly updated. TIMESTAMP → all 7 standard grains.
    expect(output).toContain(
      'timeGrains: "day" | "hour" | "minute" | "month" | "quarter" | "week" | "year"',
    );
    expect(output).toContain(
      "@timeGrain day|hour|minute|month|quarter|week|year",
    );
    expect(output).toContain('"created_at": string | null');
    expect(output).toContain('"region": string | null');
  });
});

// ── The emitted file is a real `.ts` carrying the erasable `declare module`
// augmentation alongside a runtime `metricViewsMetadata` value, so its header
// must stay a type-only import. See `generateMetricTypeDeclarations`.
describe("generateMetricTypeDeclarations — runtime metricViewsMetadata value", () => {
  test("emits both the declare-module augmentation and the metricViewsMetadata const", async () => {
    const resolution = resolveMetricConfig({
      metricViews: {
        revenue: { source: "appkit_demo.public.revenue_metrics" },
      },
    });
    const fetcher = async () =>
      mockDescribeResponse({
        columns: [
          {
            name: "arr",
            type: "DECIMAL(38,2)",
            is_measure: true,
            display_name: "Annual Recurring Revenue",
            format: "$#,##0.00",
          },
          { name: "region", type: "STRING", is_measure: false },
        ],
      });
    const { schemas } = await syncMetrics(resolution, fetcher);
    const output = generateMetricTypeDeclarations(schemas);

    // Type half: the augmentation is still present, unchanged in shape.
    expect(output).toContain('declare module "@databricks/appkit-ui/react"');
    expect(output).toContain("interface MetricRegistry");
    // Value half: a runtime const conforming to MetricViewsMetadata, `as const`.
    expect(output).toContain("export const metricViewsMetadata = {");
    expect(output).toContain("} as const;");
    // The measure/dimension maps carry the same per-column fields as the type
    // block (type/display_name/format), keyed by column name.
    expect(output).toContain(
      '"arr": { type: "DECIMAL(38,2)", display_name: "Annual Recurring Revenue", format: "$#,##0.00" }',
    );
    expect(output).toContain('"region": { type: "STRING" }');
  });

  test("uses a zero-runtime type-only import, never a side-effect import", () => {
    const output = generateMetricTypeDeclarations([]);
    // A bare `import "..."` in a `.ts` would execute the client entry on the
    // Node server.
    expect(output).not.toContain('import "@databricks/appkit-ui/react"');
    expect(output).toContain(
      'import type {} from "@databricks/appkit-ui/react"',
    );
  });

  test("emits an empty metricViewsMetadata for no registered metrics", () => {
    const output = generateMetricTypeDeclarations([]);
    expect(output).toContain("export const metricViewsMetadata = {} as const;");
    // Empty type augmentation stays too.
    expect(output).toContain("interface MetricRegistry {}");
  });

  test("a degraded schema contributes empty measures/dimensions value maps", async () => {
    const resolution = resolveMetricConfig({
      metricViews: { cold: { source: "appkit_demo.public.cold" } },
    });
    // Non-terminal DESCRIBE → degraded schema (empty column arrays).
    const fetcher =
      async (): Promise<DatabricksStatementExecutionResponse> => ({
        statement_id: "stmt-mock",
        status: { state: "PENDING" },
      });
    const { schemas } = await syncMetrics(resolution, fetcher);
    const output = generateMetricTypeDeclarations(schemas);
    // Value side of a degraded entry: empty maps, consistent with its
    // `Record<string, never>` metadata type block.
    expect(output).toContain(`"cold": {
    measures: {},
    dimensions: {},
  }`);
  });

  test("escapes quotes/backticks in display_name and description via JSON.stringify", async () => {
    const resolution = resolveMetricConfig({
      metricViews: { revenue: { source: "appkit_demo.public.revenue" } },
    });
    const fetcher = async () =>
      mockDescribeResponse({
        columns: [
          {
            name: "arr",
            type: "DECIMAL(38,2)",
            is_measure: true,
            // A double quote AND a backtick — both must survive into a valid
            // TS string literal in the runtime const.
            display_name: 'Net "ARR" `growth`',
            comment: 'Revenue with a " quote',
          },
        ],
      });
    const { schemas } = await syncMetrics(resolution, fetcher);
    const output = generateMetricTypeDeclarations(schemas);

    // JSON.stringify escapes the embedded double quotes; the backtick rides
    // through unescaped inside a double-quoted literal (valid TS).
    expect(output).toContain('display_name: "Net \\"ARR\\" `growth`"');
    expect(output).toContain('description: "Revenue with a \\" quote"');
  });
});

// ── semantic-metadata extraction (display_name + format) ──────────────────
describe("extractMetricColumns — semantic metadata", () => {
  test("captures display_name from a measure column", () => {
    const cols = extractMetricColumns({
      columns: [
        {
          name: "arr",
          type: "DECIMAL(38,2)",
          is_measure: true,
          display_name: "Annual Recurring Revenue",
          comment: "ARR for the period",
        },
      ],
    });
    expect(cols[0]).toMatchObject({
      name: "arr",
      type: "DECIMAL(38,2)",
      isMeasure: true,
      displayName: "Annual Recurring Revenue",
      description: "ARR for the period",
    });
  });

  test("captures format spec from a measure column", () => {
    const cols = extractMetricColumns({
      columns: [
        {
          name: "arr",
          type: "DECIMAL(38,2)",
          is_measure: true,
          format: "$#,##0.00",
        },
      ],
    });
    expect(cols[0].format).toBe("$#,##0.00");
  });

  test("captures display_name + format on a dimension column", () => {
    const cols = extractMetricColumns({
      columns: [
        {
          name: "region",
          type: "STRING",
          is_measure: false,
          display_name: "Region",
          format: undefined,
        },
      ],
    });
    expect(cols[0]).toMatchObject({
      name: "region",
      isMeasure: false,
      displayName: "Region",
    });
    expect(cols[0].format).toBeUndefined();
  });

  test("falls back to displayName camelCase variant", () => {
    const cols = extractMetricColumns({
      columns: [
        {
          name: "mrr",
          type: "DECIMAL",
          is_measure: true,
          displayName: "Monthly Recurring Revenue",
        },
      ],
    });
    expect(cols[0].displayName).toBe("Monthly Recurring Revenue");
  });

  test("reads display_name + format from metadata.<name> (DESCRIBE wrap)", () => {
    const cols = extractMetricColumns({
      columns: [
        {
          name: "arr",
          type: "DECIMAL(38,2)",
          metadata: {
            is_measure: true,
            display_name: "ARR",
            format: "$#,##0.00",
          },
        },
      ],
    });
    expect(cols[0]).toMatchObject({
      isMeasure: true,
      displayName: "ARR",
      format: "$#,##0.00",
    });
  });

  test("treats empty / whitespace display_name as absent", () => {
    const cols = extractMetricColumns({
      columns: [
        {
          name: "arr",
          type: "DECIMAL",
          is_measure: true,
          display_name: "   ",
          format: "",
        },
      ],
    });
    expect(cols[0].displayName).toBeUndefined();
    expect(cols[0].format).toBeUndefined();
  });

  test("captures format from format_spec alias", () => {
    const cols = extractMetricColumns({
      columns: [
        {
          name: "arr",
          type: "DECIMAL",
          is_measure: true,
          format_spec: "$#,##0.00",
        },
      ],
    });
    expect(cols[0].format).toBe("$#,##0.00");
  });

  // ── Structured-format translation (UC YAML 1.1 → printf string) ────────
  // DESCRIBE TABLE EXTENDED ... AS JSON wraps the format type as the outer
  // key: { currency: { ... } } / { percent: { ... } } / { number: { ... } }.
  // The extractor translates these into printf strings consumable by
  // formatValue / toD3Format.
  test("translates structured currency format with USD", () => {
    const cols = extractMetricColumns({
      columns: [
        {
          name: "arr",
          type: "DOUBLE",
          is_measure: true,
          metadata: {
            format: {
              currency: {
                decimal_places: { type: "EXACT", places: 2 },
                currency_code: "USD",
              },
            },
          },
        },
      ],
    });
    expect(cols[0].format).toBe("$#,##0.00");
  });

  test("translates structured currency format with EUR + 0 decimal places", () => {
    const cols = extractMetricColumns({
      columns: [
        {
          name: "ticket_price",
          type: "DOUBLE",
          is_measure: true,
          metadata: {
            format: {
              currency: {
                decimal_places: { places: 0 },
                currency_code: "EUR",
              },
            },
          },
        },
      ],
    });
    expect(cols[0].format).toBe("€#,##0");
  });

  test("falls back to ISO code as literal prefix for unknown currencies", () => {
    const cols = extractMetricColumns({
      columns: [
        {
          name: "amount",
          type: "DOUBLE",
          is_measure: true,
          metadata: {
            format: {
              currency: {
                decimal_places: { places: 2 },
                currency_code: "AUD",
              },
            },
          },
        },
      ],
    });
    expect(cols[0].format).toBe("AUD #,##0.00");
  });

  test("translates structured percent format with 1 decimal place", () => {
    const cols = extractMetricColumns({
      columns: [
        {
          name: "churn_rate",
          type: "DECIMAL",
          is_measure: true,
          metadata: {
            format: {
              percent: { decimal_places: { places: 1 } },
            },
          },
        },
      ],
    });
    expect(cols[0].format).toBe("0.0%");
  });

  test("translates structured percent with 0 decimal places", () => {
    const cols = extractMetricColumns({
      columns: [
        {
          name: "rate",
          type: "DECIMAL",
          is_measure: true,
          metadata: { format: { percent: { decimal_places: { places: 0 } } } },
        },
      ],
    });
    expect(cols[0].format).toBe("0%");
  });

  test("translates structured number format with comma grouping", () => {
    const cols = extractMetricColumns({
      columns: [
        {
          name: "active_accounts",
          type: "BIGINT",
          is_measure: true,
          metadata: {
            format: { number: { decimal_places: { places: 0 } } },
          },
        },
      ],
    });
    expect(cols[0].format).toBe("#,##0");
  });

  test("returns undefined for unrecognized structured format shapes", () => {
    const cols = extractMetricColumns({
      columns: [
        {
          name: "weirdo",
          type: "DOUBLE",
          is_measure: true,
          metadata: {
            format: { custom_thing: { whatever: 1 } },
          },
        },
      ],
    });
    expect(cols[0].format).toBeUndefined();
  });

  test("currency format defaults to USD + 2 places when fields are missing", () => {
    const cols = extractMetricColumns({
      columns: [
        {
          name: "amount",
          type: "DOUBLE",
          is_measure: true,
          metadata: { format: { currency: {} } },
        },
      ],
    });
    expect(cols[0].format).toBe("$#,##0.00");
  });

  test("accepts decimal_places as a bare number (legacy shape)", () => {
    const cols = extractMetricColumns({
      columns: [
        {
          name: "amount",
          type: "DOUBLE",
          is_measure: true,
          metadata: {
            format: { currency: { decimal_places: 4, currency_code: "USD" } },
          },
        },
      ],
    });
    expect(cols[0].format).toBe("$#,##0.0000");
  });

  test("clamps structured decimal places to 100 (Number#toFixed RangeError bound)", () => {
    // Format specs are workspace-authored column metadata, not app config —
    // a wild `places` is clamped (never thrown) so the build still succeeds
    // and downstream toFixed-style formatters stay inside their 100-digit
    // RangeError bound.
    const cols = extractMetricColumns({
      columns: [
        {
          name: "huge",
          type: "DOUBLE",
          is_measure: true,
          metadata: {
            format: { number: { decimal_places: { places: 1000 } } },
          },
        },
      ],
    });
    expect(cols[0].format).toBe(`#,##0.${"0".repeat(100)}`);
  });

  test("clamps a bare-number decimal_places to 100 as well", () => {
    const cols = extractMetricColumns({
      columns: [
        {
          name: "huge",
          type: "DOUBLE",
          is_measure: true,
          metadata: {
            format: {
              currency: { decimal_places: 500, currency_code: "USD" },
            },
          },
        },
      ],
    });
    expect(cols[0].format).toBe(`$#,##0.${"0".repeat(100)}`);
  });
});

// ── Key-order determinism: the emitter sorts metric keys with a
// locale-independent (code-unit) comparator. localeCompare-style collation
// would interleave mixed-case keys ("ARPU", "churn", "Revenue") and could vary
// by machine/locale, drifting the emitted augmentation between builds.
describe("artifact key-order determinism", () => {
  test("mixed-case keys order code-unit (uppercase before lowercase) in metric-views.ts", async () => {
    const resolution = resolveMetricConfig({
      metricViews: {
        Revenue: { source: "a.b.r" },
        churn: { source: "a.b.c" },
        ARPU: { source: "a.b.a" },
      },
    });
    // Code-unit order puts uppercase before lowercase — NOT the
    // case-insensitive interleaving locale collation would produce.
    expect(resolution.entries.map((e) => e.key)).toEqual([
      "ARPU",
      "Revenue",
      "churn",
    ]);

    const fetcher = async () =>
      mockDescribeResponse({
        columns: [{ name: "v", type: "DOUBLE", is_measure: true }],
      });
    const { schemas } = await syncMetrics(resolution, fetcher);

    // Entry keys in the augmentation appear as `    "<key>": {` lines (4-space
    // indent — metadata column maps sit deeper and don't match).
    const declarations = generateMetricTypeDeclarations(schemas);
    const dtsKeys = [...declarations.matchAll(/^ {4}"([^"]+)": \{$/gm)].map(
      (m) => m[1],
    );

    expect(dtsKeys).toEqual(["ARPU", "Revenue", "churn"]);
  });
});

// ── syncMetrics propagates timeGrains end-to-end ─────────────────────────
describe("syncMetrics — time-typed dimension propagation", () => {
  test("propagates inferred grains onto the resulting MetricSchema", async () => {
    const resolution = resolveMetricConfig({
      metricViews: { revenue: { source: "demo.public.revenue" } },
    });

    const fetcher = async () =>
      mockDescribeResponse({
        columns: [
          { name: "arr", type: "DECIMAL", is_measure: true },
          { name: "ts", type: "TIMESTAMP", is_measure: false },
          { name: "region", type: "STRING", is_measure: false },
        ],
      });

    const { schemas } = await syncMetrics(resolution, fetcher);
    expect(schemas[0].dimensions).toHaveLength(2);
    const tsDim = schemas[0].dimensions.find((d) => d.name === "ts");
    expect(tsDim?.timeGrains).toEqual([
      "day",
      "hour",
      "minute",
      "month",
      "quarter",
      "week",
      "year",
    ]);
    const regionDim = schemas[0].dimensions.find((d) => d.name === "region");
    expect(regionDim?.timeGrains).toBeUndefined();
  });
});
