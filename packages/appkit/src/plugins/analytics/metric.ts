import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { type SQLTypeMarker, sql as sqlHelpers } from "shared";
import { z } from "zod";
// Canonical metric-source schema — the single source of truth for
// `metric-views.json`. Imported from the shared source directly (matching the
// type-generator's runtime, which pulls the zod-free `metric-fqn.ts` from the
// same tree) so the runtime and the generated JSON schema validate identically.
import {
  isValidColumnName,
  isValidFqn,
  quoteFqnForSql,
  quoteIdentifier,
} from "../../../../shared/src/schemas/metric-fqn";
import { metricSourceSchema } from "../../../../shared/src/schemas/metric-source";
import { AuthenticationError, ValidationError } from "../../errors";
import { createLogger } from "../../logging/logger";
import type {
  IAnalyticsMetricRequest,
  MetricFilter,
  MetricFilterOperatorName,
  MetricLane,
  MetricPredicate,
  MetricRegistration,
} from "./types";
import { normalizeAnalyticsFormat } from "./types";

const logger = createLogger("analytics:metric");

/**
 * Default queries directory. Mirrors `AppManager`'s
 * `path.resolve(process.cwd(), "config/queries")` so dev mode and production
 * share a single source of truth for where metric config lives. Exported so
 * `AnalyticsPlugin` can default `config.queriesDir` to the same path.
 */
export const QUERIES_DIR = path.resolve(process.cwd(), "config/queries");
const METRIC_CONFIG_FILE = "metric-views.json";

/**
 * Measure, dimension, and filter-member names are **column identifiers**: they
 * are validated by the shared {@link isValidColumnName} (rejects only control
 * characters / newlines) and backtick-quoted via {@link quoteIdentifier} at
 * every interpolation point. Quoting — not a narrow ASCII allowlist — is the
 * injection boundary, so the runtime accepts the full delimited-identifier
 * grammar the type-generator emits from DESCRIBE (hyphens, dots, non-ASCII).
 * There is deliberately NO name allowlist: a well-formed-but-unknown column
 * falls through to the warehouse and surfaces as a sanitized canonical error.
 *
 * Time-grain token shape. Unlike the column identifiers above, the grain is
 * interpolated as a single-quoted `date_trunc` unit LITERAL (NOT a bind param,
 * NOT a delimited identifier) in {@link renderDimensionClause}, so it keeps a
 * narrow keyword-shaped gate — that pattern is what keeps a hostile token out
 * of the quoted-literal position.
 */
const TIME_GRAIN_PATTERN = /^[a-z][a-z_]*$/;

/**
 * The exact twelve filter operators allowed at v1. The runtime tuple is the
 * server-side source of truth; the client-side type union
 * `MetricFilterOperatorName` mirrors these names statically.
 */
const METRIC_FILTER_OPERATORS = [
  "equals",
  "notEquals",
  "in",
  "notIn",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "notContains",
  "set",
  "notSet",
] as const satisfies readonly MetricFilterOperatorName[];

/**
 * Maximum AND/OR nesting depth. The PRD documents 8 as a sensible cap —
 * enough for any real BI filter UI, low enough that a hostile or malformed
 * payload cannot stack-overflow the recursive validator or translator.
 *
 * The depth count is the number of nested `{ and }` / `{ or }` wrappers
 * encountered while descending — leaf predicates do not count toward depth.
 */
const METRIC_FILTER_MAX_DEPTH = 8;

/**
 * Cardinality caps on user-controlled arrays. Closes the recurring
 * `unbounded-request-parameters` finding: a hostile caller could otherwise
 * send `values: [...10M items...]` and exhaust the validator + the named
 * bind-var binding step. The limits below are deliberately generous — higher
 * than any real BI UI would emit — so legitimate traffic never trips them.
 */
const METRIC_MEASURES_MAX = 50;
const METRIC_DIMENSIONS_MAX = 20;
const METRIC_FILTER_VALUES_MAX = 1000;
const METRIC_LIMIT_MAX = 100_000;

/**
 * Maximum number of children per AND/OR group node. Without this cap a single
 * flat group like `{ and: [...10M empty objects...] }` would push tens of
 * millions of frames onto the iterative pre-check's stack — OOM before
 * validation even gets to Zod. The Zod schema enforces the same cap so the
 * rejection point is consistent regardless of which validator catches it
 * first.
 */
const METRIC_FILTER_GROUP_MAX = 100;

/** Operators that require exactly one value. */
const SINGLE_VALUE_OPERATORS = new Set<MetricFilterOperatorName>([
  "equals",
  "notEquals",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "notContains",
]);

/** Operators that require at least one value. */
const LIST_VALUE_OPERATORS = new Set<MetricFilterOperatorName>(["in", "notIn"]);

/** Operators that reject `values` entirely. */
const NULL_OPERATORS = new Set<MetricFilterOperatorName>(["set", "notSet"]);

/** Operators that emit `LIKE` / `NOT LIKE` and require a string value. */
const STRING_OPERATORS = new Set<MetricFilterOperatorName>([
  "contains",
  "notContains",
]);

/**
 * Map an entry's declared `executor` to the internal execution lane:
 *   - `"user"`                → `"obo"` (per-user cache, on-behalf-of)
 *   - `"app_service_principal"` (default) → `"sp"` (shared cache)
 */
function laneFromExecutor(
  executor: "app_service_principal" | "user",
): MetricLane {
  return executor === "user" ? "obo" : "sp";
}

/**
 * Read and validate `config/queries/metric-views.json` into a metric registry.
 *
 * Async and stateless — registration is a pure config parse with no warehouse
 * round-trip, no `DESCRIBE`, and no build-time metadata bundle. The single
 * `metricViews` map makes keys unique by construction, so there is no
 * cross-lane duplicate-key check. Async I/O (rather than `readFileSync`) keeps
 * the event loop free: metric views are already heavier than a plain `.sql`
 * query on the warehouse side, so the SDK layer must not add a blocking read
 * on top. Caching + mtime-revalidation is layered on top by
 * {@link getMetricRegistry} — this function always hits disk.
 *
 * Returns an empty registry when the file is absent: the metric-view path is
 * additive and dormant until an app opts in by adding the config. A malformed
 * file (unreadable, invalid JSON, or schema violation) throws — the caller
 * surfaces a 503 rather than masking a broken deployment as a 404 for every
 * key. The failure is NOT cached (see {@link getMetricRegistry}), so fixing the
 * file heals on the next request.
 */
export async function loadMetricRegistry(
  queriesDir: string = QUERIES_DIR,
): Promise<Record<string, MetricRegistration>> {
  const metricPath = path.join(queriesDir, METRIC_CONFIG_FILE);

  let raw: string;
  try {
    raw = await fs.readFile(metricPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return Object.create(null);
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse metric-views.json at ${metricPath}: ${(err as Error).message}`,
    );
  }

  const result = metricSourceSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid metric-views.json at ${metricPath}: ${issues}`);
  }

  // Null-prototype map so a metric key that collides with an inherited
  // `Object.prototype` member (`__proto__`, `constructor`, `toString`, …)
  // cannot resolve to a truthy non-registration at the `registry[key]` read
  // site and slip past the unknown-key 404. Keys are still grammar-gated by
  // `metricKeySchema` (identifier shape), but the null prototype removes the
  // whole class of inherited-property lookups as a boundary.
  const registry: Record<string, MetricRegistration> = Object.create(null);
  for (const [key, entry] of Object.entries(result.data.metricViews ?? {})) {
    registry[key] = {
      key,
      source: entry.source,
      lane: laneFromExecutor(entry.executor),
    };
  }

  logger.debug(
    "Loaded metric registry: %d entry(ies)",
    Object.keys(registry).length,
  );
  return registry;
}

/**
 * Signature of the config file the cached registry was parsed from: its
 * change time, modification time, and size — all from one `stat`, no read.
 *
 * `ctimeMs` (inode change time) is the key guard against a stale serve: it
 * bumps on ANY metadata or content change and, unlike `mtimeMs`, cannot be
 * restored to a prior value by tooling (`utimes` sets atime/mtime but not
 * ctime). So an edit that preserves both size and mtime — a same-length value
 * swap (e.g. repointing `source` to an equal-length FQN, or flipping
 * `executor` between two equal-length values) on a coarse-mtime filesystem —
 * still changes ctime and invalidates the cache. Without it, such an edit
 * could serve a stale `source`/`lane`, reintroducing the exact stale-serve
 * class the cache-key `source` salt was added to prevent, one layer up.
 * A content hash would be stronger still but requires reading the file, which
 * is the cost this cache exists to avoid.
 */
interface RegistryCacheSignature {
  ctimeMs: number;
  mtimeMs: number;
  size: number;
}

/**
 * Module-level registry cache, keyed by the resolved queries directory.
 *
 * Keyed by DIR (not by plugin instance) because the registry is a pure
 * function of the config file at that path — warehouse-independent, and two
 * `AnalyticsPlugin` instances pointed at the same `config/queries/` MUST see
 * the same registry. Instance state would parse the identical file twice and
 * risk divergence; a dir-keyed module cache shares one parse.
 */
const metricRegistryCache = new Map<
  string,
  {
    signature: RegistryCacheSignature;
    registry: Record<string, MetricRegistration>;
  }
>();

/**
 * Clear the module-level registry cache.
 *
 * @internal FOR TESTS ONLY. The cache is keyed by directory and lives for the
 * process; production never needs to clear it (a changed file is picked up via
 * the stat signature). Tests that reuse a directory — or assert cold-load
 * behavior — call this in `beforeEach`/`afterEach` so isolation is intentional
 * rather than relying on each test happening to use a unique temp dir.
 */
export function __resetMetricRegistryCache(): void {
  metricRegistryCache.clear();
}

/**
 * Resolve the metric registry for `queriesDir`, re-reading + re-parsing only
 * when `metric-views.json` has changed since the cached copy.
 *
 * Behaves like the sibling `.sql` query path (which re-reads per request) but
 * cheaper: the steady-state cost is a single async `stat`, and the read +
 * `JSON.parse` + zod validation are skipped when the file's
 * `(ctimeMs, mtimeMs, size)` signature is unchanged. This delivers the agreed
 * semantics without the old permanent memo:
 *
 *  - **Hot-reload** — editing a working config bumps `mtimeMs`, so the next
 *    request re-parses and serves the new registry with no server restart.
 *  - **Self-heal** — a load failure is NOT cached (we only populate the cache
 *    on a successful parse), so a fixed config is picked up on the next
 *    request instead of latching a 503 forever.
 *  - **Dormant** — an absent file `stat`s as `ENOENT` → empty registry; adding
 *    the file later is picked up on the next request.
 *
 * Concurrency: two simultaneous cold requests may both `stat`+read before
 * either populates the cache. That is a harmless redundant read of the same
 * file (the sibling `.sql` path does not single-flight either), so no lock is
 * taken.
 *
 * @throws Propagates {@link loadMetricRegistry}'s throw on a malformed file so
 * the route can surface a 503; the cache is left untouched on failure.
 */
export async function getMetricRegistry(
  queriesDir: string = QUERIES_DIR,
): Promise<Record<string, MetricRegistration>> {
  const metricPath = path.join(queriesDir, METRIC_CONFIG_FILE);

  let signature: RegistryCacheSignature | null;
  try {
    const stats = await fs.stat(metricPath);
    signature = {
      ctimeMs: stats.ctimeMs,
      mtimeMs: stats.mtimeMs,
      size: stats.size,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Absent file → dormant. Drop any stale cache entry (the file may have
      // been deleted) and return an empty registry without touching the cache.
      metricRegistryCache.delete(queriesDir);
      signature = null;
    } else {
      // Any other stat error (EACCES / EIO / ELOOP / …) is deliberately fatal
      // for THIS request → the route surfaces a 503, consistent with the
      // malformed-config → 503 path. It is not latched: with the self-heal
      // design a transient error clears on the next request, which is strictly
      // better than the old memo that could latch-and-serve-stale.
      throw err;
    }
  }

  if (signature === null) {
    return Object.create(null);
  }

  const cached = metricRegistryCache.get(queriesDir);
  if (
    cached !== undefined &&
    cached.signature.ctimeMs === signature.ctimeMs &&
    cached.signature.mtimeMs === signature.mtimeMs &&
    cached.signature.size === signature.size
  ) {
    return cached.registry;
  }

  // Cold or stale: re-read + re-parse. Cache ONLY on success so a malformed
  // file never latches — the next request re-attempts and heals.
  const registry = await loadMetricRegistry(queriesDir);
  metricRegistryCache.set(queriesDir, { signature, registry });
  return registry;
}

/**
 * Validate a metric-view FQN and return it backtick-quoted for interpolation.
 *
 * The FQN ships in the SQL string — it cannot be parameterized — so it passes
 * two shared, zod-free gates at construction time:
 *
 *  1. {@link isValidFqn} — the three-part UC grammar (exactly three segments,
 *     each matching `UC_FQN_PATTERN`). This is the SAME predicate the
 *     type-generator's describe seam uses and is derived from the same
 *     per-segment charset as the canonical Zod schema, so config-time,
 *     generation-time, and runtime accept exactly the same names.
 *  2. {@link quoteFqnForSql} — backtick-quotes each segment (doubling embedded
 *     backticks) so the FQN cannot break out of its identifier position. This
 *     is the injection boundary; it is why the runtime can accept the full UC
 *     quoted-identifier grammar (hyphens, non-ASCII) rather than the narrow
 *     ASCII allowlist it used before.
 *
 * The registry loader already enforces the grammar via `metricSourceSchema`;
 * this re-gate is defense-in-depth for any code path that reaches
 * `buildMetricSql` without going through a parsed registry (it is exported),
 * matching how measures, dimensions, and the grain are each re-gated at their
 * interpolation points.
 */
function quoteSafeFqn(fqn: string): string {
  if (!isValidFqn(fqn)) {
    throw new Error(
      `Refusing to build SQL: "${fqn}" is not a valid three-part UC FQN.`,
    );
  }
  return quoteFqnForSql(fqn);
}

/**
 * Structural validation schema for the metric request body.
 *
 * The schema is **static** — any grammar-valid measure/dimension identifier is
 * accepted; it is NOT a dynamic per-key `z.enum(knownMeasures)`. Unknown-but-
 * well-formed names are not rejected here; they reach the warehouse and surface
 * as a sanitized canonical error. The identifier grammar gate is enforced in
 * {@link buildMetricSql}/{@link renderFilter} at interpolation time; the body
 * schema stays structural (item shape, cardinality caps, operator enum,
 * per-operator value cardinality, and AND/OR depth).
 *
 * `filter` is recursive (`Predicate | { and: [...] } | { or: [...] }`), built
 * with `z.lazy`. `timeGrain` buckets `timeDimension` via `date_trunc` (see
 * {@link renderDimensionClause}); the two cross-field rules (grain requires
 * timeDimension; timeDimension must be one of dimensions) live in the
 * `superRefine` below.
 */

/** A leaf predicate: `{ member, operator, values? }`, no extra keys. */
const filterPredicateSchema: z.ZodType<MetricPredicate> = z
  .object({
    member: z
      .string()
      .min(1, { message: "filter predicate 'member' cannot be empty" })
      .refine(isValidColumnName, {
        message:
          "filter predicate 'member' contains a character that cannot be used in a SQL identifier (control character or newline)",
      }),
    operator: z.string().min(1, {
      message: "filter predicate 'operator' cannot be empty",
    }) as z.ZodType<MetricFilterOperatorName>,
    values: z
      .array(z.union([z.string(), z.number()]))
      .max(METRIC_FILTER_VALUES_MAX, {
        message: `filter predicate 'values' length exceeds the maximum of ${METRIC_FILTER_VALUES_MAX}`,
      })
      .optional(),
  })
  .strict();

/** Recursive filter: a predicate leaf or an `{ and }` / `{ or }` group. */
const filterSchema: z.ZodType<MetricFilter> = z.lazy(() =>
  z.union([
    filterPredicateSchema,
    z
      .object({
        and: z.array(filterSchema).max(METRIC_FILTER_GROUP_MAX, {
          message: `filter 'and' group exceeds the maximum of ${METRIC_FILTER_GROUP_MAX} children`,
        }),
      })
      .strict(),
    z
      .object({
        or: z.array(filterSchema).max(METRIC_FILTER_GROUP_MAX, {
          message: `filter 'or' group exceeds the maximum of ${METRIC_FILTER_GROUP_MAX} children`,
        }),
      })
      .strict(),
  ]),
);

const metricRequestSchema = z
  .object({
    measures: z
      .array(
        z
          .string()
          .min(1, "measure name cannot be empty")
          .refine(isValidColumnName, {
            message:
              "measure name contains a character that cannot be used in a SQL identifier (control character or newline)",
          }),
      )
      .min(1, "at least one measure is required")
      .max(METRIC_MEASURES_MAX, {
        message: `measures length exceeds the maximum of ${METRIC_MEASURES_MAX}`,
      }),
    dimensions: z
      .array(
        z
          .string()
          .min(1, "dimension name cannot be empty")
          .refine(isValidColumnName, {
            message:
              "dimension name contains a character that cannot be used in a SQL identifier (control character or newline)",
          }),
      )
      .max(METRIC_DIMENSIONS_MAX, {
        message: `dimensions length exceeds the maximum of ${METRIC_DIMENSIONS_MAX}`,
      })
      .optional(),
    filter: filterSchema.optional(),
    // Grammar-shaped bucketing grain, applied to `timeDimension` via
    // `date_trunc`. The token is validated for safety here; the grain literal
    // is interpolated (single-quoted, never a bind param) in
    // `renderDimensionClause`, so this pattern gate is the security boundary.
    timeGrain: z
      .string()
      .min(1, { message: "timeGrain cannot be empty" })
      .regex(TIME_GRAIN_PATTERN, {
        message: "timeGrain must match /^[a-z][a-z_]*$/",
      })
      .optional(),
    // The single dimension `timeGrain` applies to via `date_trunc`. A column
    // identifier (backtick-quoted at interpolation), so it accepts the full
    // delimited-identifier grammar. Cross-field rules in `superRefine`:
    // required when `timeGrain` is set, and must be one of `dimensions`.
    timeDimension: z
      .string()
      .min(1, { message: "timeDimension cannot be empty" })
      .refine(isValidColumnName, {
        message:
          "timeDimension contains a character that cannot be used in a SQL identifier (control character or newline)",
      })
      .optional(),
    limit: z
      .number()
      .int({ message: "limit must be an integer" })
      .positive({ message: "limit must be positive" })
      .max(METRIC_LIMIT_MAX, {
        message: `limit exceeds the maximum of ${METRIC_LIMIT_MAX}`,
      })
      .optional(),
    format: z.enum(["JSON_ARRAY", "ARROW_STREAM", "JSON", "ARROW"]).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.filter != null) {
      validateFilterTree(value.filter, ctx, ["filter"], 0);
    }

    // Uniqueness. Measures and dimensions become SELECT columns aliased to
    // their own name (`MEASURE(x) AS x`, `x`); the warehouse returns one row
    // object keyed by column name, so a repeated name — a duplicate measure, a
    // duplicate dimension, or a name appearing as BOTH a measure and a
    // dimension — collapses to a single key and silently drops a value during
    // row materialization. Reject the collision here rather than emit SQL that
    // corrupts rows. (The grammar gate at build time is a safety boundary, not
    // a uniqueness check, so this lives in validation.)
    const seen = new Set<string>();
    const collided = new Set<string>();
    for (const name of [...value.measures, ...(value.dimensions ?? [])]) {
      if (seen.has(name)) {
        collided.add(name);
      }
      seen.add(name);
    }
    if (collided.size > 0) {
      ctx.addIssue({
        code: "custom",
        message:
          "measures and dimensions must be unique across both lists (a name cannot repeat, nor appear as both a measure and a dimension)",
        path: ["measures"],
      });
    }

    // Delivery format. The metric route delivers JSON rows only at v1 (the
    // cache salts on a fixed "JSON_ARRAY" and the route always routes through
    // the JSON path). Accepting an Arrow format would silently return JSON —
    // reject it loudly until Arrow parity ships. Legacy aliases normalize
    // first (`JSON`→`JSON_ARRAY`, `ARROW`→`ARROW_STREAM`).
    if (
      value.format != null &&
      normalizeAnalyticsFormat(value.format) !== "JSON_ARRAY"
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "format: only JSON_ARRAY is supported on the metric route at v1 (ARROW_STREAM is not yet implemented)",
        path: ["format"],
      });
    }

    // Cross-field grain rules. `timeGrain` buckets exactly one selected
    // dimension via `date_trunc`, so it requires an explicit `timeDimension`,
    // and that dimension must be selected (so it is in the SELECT list and
    // `GROUP BY ALL`).
    if (value.timeGrain != null && value.timeDimension == null) {
      ctx.addIssue({
        code: "custom",
        message: "timeDimension is required when timeGrain is set",
        path: ["timeDimension"],
      });
    }
    if (
      value.timeDimension != null &&
      !(value.dimensions ?? []).includes(value.timeDimension)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "timeDimension must be one of dimensions",
        path: ["timeDimension"],
      });
    }
  }) as z.ZodType<IAnalyticsMetricRequest>;

/**
 * Recursive Zod-time validator for the filter tree.
 *
 * Pushes structured issues into the refinement context with stable paths
 * (`filter.and.0.or.2.member`, etc.) so the canonical 400 error carries
 * actionable diagnostics. Keeps the registry-free concerns in one descent:
 *
 *  1. Operator is one of the twelve.
 *  2. Per-operator value cardinality (single / list / null operators).
 *  3. `contains`/`notContains` carry a string value.
 *  4. AND/OR nesting depth cap.
 *
 * There is NO member-allowlist and NO op⇄dimension-type check — the member is
 * grammar-gated at SQL-build time, and dimension types are not tracked (no
 * registry metadata). Returns void; issues accumulate on `ctx`.
 */
function validateFilterTree(
  node: MetricFilter,
  ctx: z.RefinementCtx,
  path: Array<string | number>,
  depth: number,
): void {
  if (node === null || typeof node !== "object") {
    // The base schema rejects this via the union, but stay defensive.
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: "filter node must be a Predicate or { and } / { or } group",
    });
    return;
  }

  if ("and" in node || "or" in node) {
    if (depth + 1 > METRIC_FILTER_MAX_DEPTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message: `filter AND/OR nesting exceeds the maximum depth of ${METRIC_FILTER_MAX_DEPTH}`,
      });
      return;
    }

    const groupKey = "and" in node ? "and" : "or";
    const children = (
      node as { and?: ReadonlyArray<MetricFilter> } & {
        or?: ReadonlyArray<MetricFilter>;
      }
    )[groupKey];

    if (!Array.isArray(children)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, groupKey],
        message: `filter ${groupKey} group must be an array of predicates or nested groups`,
      });
      return;
    }

    // Reject empty `or` groups: an empty disjunction is vacuously false, which
    // silently drops the surrounding intent. Empty `and` is OK (vacuously true
    // → no constraint). Forcing the caller to omit the predicate entirely is
    // the only unambiguous choice.
    if (groupKey === "or" && children.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "or"],
        message: "filter 'or' group must contain at least one predicate",
      });
      return;
    }

    children.forEach((child, idx) => {
      validateFilterTree(child, ctx, [...path, groupKey, idx], depth + 1);
    });
    return;
  }

  // Leaf predicate. The base schema already enforced shape; here we layer in
  // the operator vocabulary + per-operator value cardinality.
  const predicate = node as MetricPredicate;

  if (
    !METRIC_FILTER_OPERATORS.includes(
      predicate.operator as MetricFilterOperatorName,
    )
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...path, "operator"],
      message: `filter operator "${predicate.operator}" is not one of: ${METRIC_FILTER_OPERATORS.join(", ")}`,
    });
    // No further checks meaningful when the operator is unknown.
    return;
  }

  const op = predicate.operator;
  const values = predicate.values;
  const valuesLen = values?.length ?? 0;

  if (NULL_OPERATORS.has(op)) {
    if (values != null && valuesLen > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "values"],
        message: `filter operator "${op}" must not carry values`,
      });
    }
  } else if (SINGLE_VALUE_OPERATORS.has(op)) {
    if (valuesLen !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "values"],
        message: `filter operator "${op}" requires exactly one value (got ${valuesLen})`,
      });
    }
  } else if (LIST_VALUE_OPERATORS.has(op)) {
    if (valuesLen < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "values"],
        message: `filter operator "${op}" requires at least one value`,
      });
    }
  }

  // Op⇄value-type: string operators require a string value. This is a
  // registry-free structural check (not an op⇄dimension-type check) — it
  // converts what would otherwise be a synchronous throw in `renderPredicate`
  // (rendered as a 500) into a clean 400 at validation time.
  if (STRING_OPERATORS.has(op) && valuesLen > 0) {
    const v = predicate.values?.[0];
    if (typeof v !== "string") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "values"],
        message: `filter operator "${op}" requires a string value (got ${typeof v})`,
      });
    }
  }
}

/**
 * Iterative pre-parse depth check. Zod's union/object parsers walk the input
 * recursively before our `superRefine` depth cap fires, so a deeply-nested
 * `{ and: [{ and: [...] }] }` payload could stack-overflow during parse, never
 * reaching the validator's depth check. This walk is iterative (explicit
 * stack) and aborts as soon as `METRIC_FILTER_MAX_DEPTH` is exceeded, so a
 * hostile payload of any size cannot drive the call stack.
 *
 * Walks BOTH `and` and `or` branches when both are present on the same node —
 * Zod's `.strict()` rejects the multi-key shape downstream, but the pre-check
 * has to inspect every branch Zod might recurse into (an earlier version used
 * `else if` and was bypassed by `{ and: [], or: <deep> }`).
 *
 * Group-children breadth is also capped: a flat `{ and: [...10M items...] }`
 * cannot push 10M frames onto the explicit stack here. Predicate leaves do NOT
 * count toward depth — only nested `and` / `or` wrappers — matching the rule
 * {@link validateFilterTree} enforces.
 */
function preCheckFilterDepth(filter: unknown): void {
  if (filter == null || typeof filter !== "object") return;
  const stack: Array<[unknown, number]> = [[filter, 0]];
  while (stack.length > 0) {
    const popped = stack.pop();
    if (popped === undefined) continue;
    const [node, depth] = popped;
    if (node == null || typeof node !== "object") continue;
    const obj = node as Record<string, unknown>;
    for (const groupKey of ["and", "or"] as const) {
      const children = obj[groupKey];
      if (!Array.isArray(children)) continue;
      if (children.length > METRIC_FILTER_GROUP_MAX) {
        throw new ValidationError(
          "Invalid metric request body (fields: filter)",
          {
            context: {
              reason: `filter ${groupKey} group has ${children.length} children; the maximum is ${METRIC_FILTER_GROUP_MAX}`,
            },
          },
        );
      }
      if (depth + 1 > METRIC_FILTER_MAX_DEPTH) {
        throw new ValidationError(
          "Invalid metric request body (fields: filter)",
          {
            context: {
              reason: `filter AND/OR nesting exceeds the maximum depth of ${METRIC_FILTER_MAX_DEPTH}`,
            },
          },
        );
      }
      for (const child of children) {
        stack.push([child, depth + 1]);
      }
    }
  }
}

/**
 * Validate a `POST /api/analytics/metric/:key` request body against the static
 * structured shape. Throws {@link ValidationError} (a 400 on the canonical
 * error path) with the offending field paths; the raw values stay in telemetry
 * context, never the public body.
 *
 * The recursion depth is bounded BEFORE Zod sees the input — the schema's own
 * depth check fires inside `superRefine`, which only runs after Zod's recursive
 * parse has already walked the tree on the call stack.
 */
export function validateMetricRequest(body: unknown): IAnalyticsMetricRequest {
  if (body != null && typeof body === "object") {
    preCheckFilterDepth((body as { filter?: unknown }).filter);
  }
  const result = metricRequestSchema.safeParse(body);
  if (!result.success) {
    const fieldPaths = result.error.issues
      .map((i) => i.path.join(".") || "(root)")
      .join(", ");
    throw new ValidationError(
      fieldPaths.length > 0
        ? `Invalid metric request body (fields: ${fieldPaths})`
        : "Invalid metric request body",
      { context: { issues: result.error.issues } },
    );
  }
  return result.data;
}

/**
 * Construct the metric SQL.
 *
 * Shape:
 *
 *   SELECT MEASURE(m) AS m[, …][, <dim>…]
 *     FROM <fqn>
 *    [WHERE <filter expression>]
 *    [GROUP BY ALL]
 *    [LIMIT n]
 *
 * Notes:
 *  - Every measure and dimension is validated by {@link isValidColumnName} and
 *    backtick-quoted by {@link quoteIdentifier} before it is interpolated
 *    (column references cannot be parameterized — they are SQL identifiers),
 *    and the FQN is validated and quoted by {@link quoteSafeFqn}. There is
 *    deliberately NO name allowlist — quoting is the security boundary. No
 *    user-supplied string reaches the SQL
 *    string without passing a grammar gate.
 *  - `GROUP BY ALL` is added when at least one dimension is requested. UC
 *    requires GROUP BY when MEASURE() is mixed with non-aggregated columns;
 *    `GROUP BY ALL` is the documented form that works without re-listing each
 *    dimension.
 *  - The `WHERE` clause is rendered from the recursive filter tree. Every value
 *    flows through Statement Execution's named bind-var path (`:f_<idx>`); no
 *    value is ever interpolated as a literal.
 *  - When `timeGrain` is set, the `timeDimension` column renders as
 *    `date_trunc('<grain>', <col>) AS <col>` (the grain is a grammar-gated
 *    single-quoted literal, not a bind param); other dimensions render bare —
 *    see {@link renderDimensionClause}.
 *
 * Returns `{ statement, parameters }` where `parameters` is the named bind-var
 * dictionary the plugin's `query()` consumes.
 */
export function buildMetricSql(
  registration: MetricRegistration,
  request: IAnalyticsMetricRequest,
): {
  statement: string;
  parameters: Record<string, SQLTypeMarker>;
} {
  const quotedSource = quoteSafeFqn(registration.source);

  if (request.measures.length === 0) {
    throw new Error("buildMetricSql requires at least one measure.");
  }

  // Defense-in-depth re-gate: `validateMetricRequest` already rejects any name
  // `isValidColumnName` refuses, but `buildMetricSql` is exported and may be
  // reached without it. `quoteIdentifier` throws on a control/newline name, so
  // the quoting below is itself the boundary; the explicit check keeps the
  // error message uniform with the other interpolated tokens.
  for (const m of request.measures) {
    if (!isValidColumnName(m)) {
      throw new Error(
        `Refusing to build SQL: measure "${m}" is not a valid identifier.`,
      );
    }
  }

  const dimensions = request.dimensions ?? [];
  for (const d of dimensions) {
    if (!isValidColumnName(d)) {
      throw new Error(
        `Refusing to build SQL: dimension "${d}" is not a valid identifier.`,
      );
    }
  }

  // Deterministic order so cache keys collapse semantically equivalent calls.
  // Alias each measure to its plain name (backtick-quoted) so result rows have
  // keys matching the registered measure (`{ "net-revenue": 1234 }`) rather
  // than the SQL-function serialization Databricks returns by default. The
  // warehouse reports the aliased column under the UNQUOTED name (backticks are
  // delimiters, not part of the name), so `MEASURE(`x`) AS `x`` yields a row
  // key of exactly `x` — preserved through result materialization.
  const measureClauses = [...request.measures]
    .sort()
    .map((m) => `MEASURE(${quoteIdentifier(m)}) AS ${quoteIdentifier(m)}`);

  const dimensionClauses = [...dimensions]
    .sort()
    .map((d) =>
      renderDimensionClause(d, request.timeGrain, request.timeDimension),
    );

  const selectList = [...measureClauses, ...dimensionClauses].join(", ");
  const groupByClause = dimensions.length > 0 ? " GROUP BY ALL" : "";

  const limitClause =
    typeof request.limit === "number" && request.limit > 0
      ? ` LIMIT ${Math.floor(request.limit)}`
      : "";

  // Filter translation. Every value is bound through `:f_<idx>` named params;
  // every column identifier is grammar-gated in `renderFilter`. Empty filter or
  // no filter → no WHERE.
  const parameters: Record<string, SQLTypeMarker> = {};
  let whereClause = "";
  if (request.filter !== undefined) {
    const fragment = renderFilter(request.filter, parameters, {
      counter: 0,
      depth: 0,
    });
    if (fragment !== null && fragment.length > 0) {
      whereClause = ` WHERE ${fragment}`;
    }
  }

  const statement = `SELECT ${selectList} FROM ${quotedSource}${whereClause}${groupByClause}${limitClause}`;
  return { statement, parameters };
}

/**
 * Mutable counter / depth threaded through {@link renderFilter}. Fresh per
 * `buildMetricSql` call, so two requests never share bind-var indexes.
 */
interface FilterRenderState {
  counter: number;
  depth: number;
}

/**
 * Recursively render a filter tree into a SQL fragment, pushing bind values
 * into `params` keyed by `:f_<idx>` names.
 *
 * Returns `null` for an empty group (no WHERE clause needed). The caller's
 * `buildMetricSql` only emits `WHERE` when this returns a non-null, non-empty
 * fragment. Empty `and: []` collapses to null (SQL's vacuous-truth semantics
 * for AND); empty `or: []` renders `1 = 0` — the validator rejects `or: []`
 * before the SQL builder, but if it slips through we render vacuous-false
 * rather than dropping the predicate silently (defense in depth so a future
 * validator bypass cannot turn `or: []` into "match everything").
 *
 * Defense-in-depth: even though the request body's filter has already been
 * validated, every member name is re-checked against {@link isValidColumnName}
 * here and backtick-quoted. If validation is ever bypassed, the SQL
 * constructor still refuses to interpolate a name it cannot safely quote.
 */
function renderFilter(
  node: MetricFilter,
  params: Record<string, SQLTypeMarker>,
  state: FilterRenderState,
): string | null {
  if (node === null || typeof node !== "object") {
    throw new Error(
      "Refusing to build SQL: filter node must be an object Predicate or { and } / { or } group.",
    );
  }

  if ("and" in node || "or" in node) {
    const groupKey = "and" in node ? "and" : "or";
    if (state.depth + 1 > METRIC_FILTER_MAX_DEPTH) {
      throw new Error(
        `Refusing to build SQL: filter AND/OR nesting exceeds the maximum depth of ${METRIC_FILTER_MAX_DEPTH}.`,
      );
    }

    const children = (
      node as { and?: ReadonlyArray<MetricFilter> } & {
        or?: ReadonlyArray<MetricFilter>;
      }
    )[groupKey];

    if (!Array.isArray(children) || children.length === 0) {
      if (groupKey === "or") {
        return "1 = 0";
      }
      return null;
    }

    // Sort-before-hash discipline: within a group, predicate leaves are
    // stable-sorted by (member, operator) before contributing to the rendered
    // fragment, so semantically equivalent calls produce the same SQL string
    // and (downstream) the same cache key.
    const sortedChildren = sortFilterChildren(children);

    const fragments: string[] = [];
    const childState: FilterRenderState = {
      counter: state.counter,
      depth: state.depth + 1,
    };
    for (const child of sortedChildren) {
      const rendered = renderFilter(child, params, childState);
      if (rendered != null && rendered.length > 0) {
        fragments.push(rendered);
      }
    }
    state.counter = childState.counter;

    if (fragments.length === 0) return null;
    if (fragments.length === 1) return fragments[0];
    const joiner = groupKey === "and" ? " AND " : " OR ";
    return `(${fragments.join(joiner)})`;
  }

  // Leaf predicate — grammar-gate the member and operator, then render.
  const predicate = node as MetricPredicate;

  if (!isValidColumnName(predicate.member)) {
    throw new Error(
      `Refusing to build SQL: filter member "${predicate.member}" is not a valid identifier.`,
    );
  }
  if (
    !METRIC_FILTER_OPERATORS.includes(
      predicate.operator as MetricFilterOperatorName,
    )
  ) {
    throw new Error(
      `Refusing to build SQL: unknown filter operator "${predicate.operator}".`,
    );
  }

  return renderPredicate(predicate, params, state);
}

/**
 * Stable-sort filter children inside an AND/OR group by `(member, operator)`.
 *
 * Predicates carry both fields and sort by their pair; nested groups sort
 * after predicates and stay in their original relative order (a nested group
 * is opaque from the outside — we cannot collapse it to a single key). This is
 * the sort-before-hash invariant applied at the SQL-fragment level so
 * downstream cache keys collapse semantically equivalent calls.
 */
function sortFilterChildren(
  children: ReadonlyArray<MetricFilter>,
): MetricFilter[] {
  const indexed = children.map((child, idx) => {
    let key: string;
    let isPredicate: boolean;
    if (
      child !== null &&
      typeof child === "object" &&
      !("and" in child) &&
      !("or" in child)
    ) {
      const p = child as MetricPredicate;
      // JSON.stringify the (member, operator) pair so the sort key is
      // injective regardless of content. A plain delimiter is unsafe now that
      // members accept the full delimited-identifier grammar (a member may
      // contain "/", ".", etc.): `member "a/b" + op "c"` and
      // `member "a" + op "b/c"` would both collapse to "a/b/c" under any
      // single-char separator, tie-breaking distinct pairs to input order.
      // JSON encoding escapes any separator, so distinct pairs map to distinct
      // keys — the same technique canonicalizeFilter uses for values.
      key = JSON.stringify([p.member, p.operator]);
      isPredicate = true;
    } else {
      // Nested groups don't have a single (member, operator) — keep their
      // original index so multiple nested groups within the same parent remain
      // stable relative to each other.
      key = "";
      isPredicate = false;
    }
    return { child, idx, key, isPredicate };
  });

  indexed.sort((a, b) => {
    if (a.isPredicate && !b.isPredicate) return -1;
    if (!a.isPredicate && b.isPredicate) return 1;
    if (a.isPredicate && b.isPredicate) {
      if (a.key < b.key) return -1;
      if (a.key > b.key) return 1;
    }
    return a.idx - b.idx;
  });

  return indexed.map((entry) => entry.child);
}

/**
 * Translate a single predicate into a SQL fragment.
 *
 * Every value flows through a freshly-allocated `:f_<idx>` named bind var.
 * Nothing from the request body is ever interpolated as a literal — the
 * fragment carries identifiers (grammar-gated) and operators (whitelisted),
 * then references the bind name for each value.
 *
 * `set` and `notSet` emit `IS NULL` / `IS NOT NULL` with no bind value. `in`
 * and `notIn` emit `IN (:f_0, :f_1, ...)`. `contains` and `notContains` emit
 * `LIKE :f_0` / `NOT LIKE :f_0` and pre-bind the value with `%` wrapping.
 */
function renderPredicate(
  predicate: MetricPredicate,
  params: Record<string, SQLTypeMarker>,
  state: FilterRenderState,
): string {
  // Backtick-quote the column identifier (defense-in-depth: the member was
  // already validated by `isValidColumnName` in `renderFilter`). Quoting is
  // what lets a delimited column name — hyphens, dots, non-ASCII — reach SQL
  // safely; the bound value still flows through `:f_<idx>` params, never here.
  const col = quoteIdentifier(predicate.member);
  const op = predicate.operator;
  const values = predicate.values ?? [];

  switch (op) {
    case "equals":
      return `${col} = ${bindValue(values[0], params, state)}`;
    case "notEquals":
      return `${col} <> ${bindValue(values[0], params, state)}`;
    case "gt":
      return `${col} > ${bindValue(values[0], params, state)}`;
    case "gte":
      return `${col} >= ${bindValue(values[0], params, state)}`;
    case "lt":
      return `${col} < ${bindValue(values[0], params, state)}`;
    case "lte":
      return `${col} <= ${bindValue(values[0], params, state)}`;
    case "in": {
      const placeholders = values.map((v) => bindValue(v, params, state));
      return `${col} IN (${placeholders.join(", ")})`;
    }
    case "notIn": {
      const placeholders = values.map((v) => bindValue(v, params, state));
      return `${col} NOT IN (${placeholders.join(", ")})`;
    }
    case "contains": {
      const raw = values[0];
      if (typeof raw !== "string") {
        throw new Error(
          `Refusing to build SQL: filter operator "contains" requires a string value (got ${typeof raw}).`,
        );
      }
      return `${col} LIKE ${bindLikeValue(raw, params, state)}`;
    }
    case "notContains": {
      const raw = values[0];
      if (typeof raw !== "string") {
        throw new Error(
          `Refusing to build SQL: filter operator "notContains" requires a string value (got ${typeof raw}).`,
        );
      }
      return `${col} NOT LIKE ${bindLikeValue(raw, params, state)}`;
    }
    case "set":
      return `${col} IS NOT NULL`;
    case "notSet":
      return `${col} IS NULL`;
    default: {
      // Exhaustiveness — the operator union is closed; if this is reached the
      // operator vocabulary widened without updating the switch.
      const _exhaustive: never = op;
      throw new Error(
        `Refusing to build SQL: unhandled filter operator "${_exhaustive as string}".`,
      );
    }
  }
}

/**
 * Allocate a fresh `:f_<idx>` bind name for `value`, push the typed marker into
 * `params`, and return the placeholder string. Bumps the counter.
 */
function bindValue(
  value: string | number | undefined,
  params: Record<string, SQLTypeMarker>,
  state: FilterRenderState,
): string {
  if (value === undefined) {
    throw new Error(
      "Refusing to build SQL: filter predicate is missing a required value.",
    );
  }
  const name = `f_${state.counter}`;
  state.counter += 1;
  if (typeof value === "number") {
    params[name] = sqlHelpers.number(value);
  } else if (typeof value === "string") {
    params[name] = sqlHelpers.string(value);
  } else {
    throw new Error(
      `Refusing to build SQL: filter value must be a string or number (got ${typeof value}).`,
    );
  }
  return `:${name}`;
}

/**
 * Like {@link bindValue}, but wraps the value in `%...%` for `LIKE` /
 * `NOT LIKE`. SQL wildcards in the user-supplied string remain in the value
 * (matching the documented "contains" semantics) — escape-on-receive could be
 * added later as an opt-in if customers request strict-substring matching.
 */
function bindLikeValue(
  value: string,
  params: Record<string, SQLTypeMarker>,
  state: FilterRenderState,
): string {
  const name = `f_${state.counter}`;
  state.counter += 1;
  params[name] = sqlHelpers.string(`%${value}%`);
  return `:${name}`;
}

/**
 * Render a single SELECT-list clause for a dimension.
 *
 * When `timeGrain` is set and `dim` is the request's `timeDimension`, the
 * column is bucketed: `date_trunc('<grain>', <col>) AS <col>`. Every other
 * dimension renders bare. Both the grain literal and the column identifier are
 * grammar-gated before they reach the SQL string:
 *
 *  - The grain is single-quoted (it is a `date_trunc` unit literal, NOT a bind
 *    param), so it is re-checked against {@link TIME_GRAIN_PATTERN} here before
 *    interpolation. The schema also gates it, but `buildMetricSql` is exported
 *    and may be reached on a path that bypasses `validateMetricRequest`, so the
 *    grammar gate is applied at the interpolation point too — matching how
 *    every other interpolated identifier (measures, dimensions, `timeDimension`,
 *    the FQN) is re-gated in the builder.
 *  - The column cannot be parameterized (it is an identifier), so it is
 *    re-checked against {@link isValidColumnName} and backtick-quoted here as
 *    belt-and-suspenders even though the schema already gated `timeDimension`.
 *
 * The aliasing keeps result-row keys stable (`{ order_date: ... }`) regardless
 * of whether the grain was applied.
 */
function renderDimensionClause(
  dim: string,
  timeGrain: string | undefined,
  timeDimension: string | undefined,
): string {
  if (timeGrain != null && dim === timeDimension) {
    if (!isValidColumnName(dim)) {
      throw new Error(
        `Refusing to build SQL: timeDimension "${dim}" is not a valid identifier.`,
      );
    }
    // The grain is interpolated as a single-quoted `date_trunc` unit literal
    // (NOT a bind param), so it stays gated by the narrow TIME_GRAIN_PATTERN —
    // it is a keyword, not a delimited identifier.
    if (!TIME_GRAIN_PATTERN.test(timeGrain)) {
      throw new Error(
        `Refusing to build SQL: timeGrain "${timeGrain}" is not a valid grain token.`,
      );
    }
    const quoted = quoteIdentifier(dim);
    return `date_trunc('${timeGrain}', ${quoted}) AS ${quoted}`;
  }
  return quoteIdentifier(dim);
}

/**
 * Compose the cache key for a metric-view request.
 *
 * Reserved namespace `metric` separates metric-view caches from query caches.
 * The returned array is consumed by `CacheManager.generateKey`, which
 * concatenates and sha256-hashes the parts — the per-concern structure keeps
 * the key inspectable in tests and debug logs without giving up determinism.
 *
 * Sort-before-hash collapses semantically equivalent calls onto one entry:
 *  - `measures` / `dimensions`: lexicographic sort.
 *  - `filter`: predicates inside each AND/OR group are stable-sorted by
 *    `(member, operator)` and the group kind (`and` vs `or`) is preserved by
 *    {@link canonicalizeFilter}; values are included verbatim so distinct
 *    filter values yield distinct keys.
 *
 * `source` (the metric view's UC FQN) salts the key so that repointing a
 * metric `key` to a different FQN in `metric-views.json` cannot serve rows
 * cached under the old source within the TTL — `metricKey` alone is not enough
 * because the key→source binding is mutable config.
 *
 * `timeGrain` salts the key whenever set. `timeDimension` only salts the key
 * when `timeGrain` is also set, because `renderDimensionClause` only applies
 * `date_trunc('<grain>', <timeDimension>)` when a grain is present — with no
 * grain the field has no effect on the emitted SQL, so including it would fork
 * the cache on an input that produced identical SQL.
 *
 * `executorKey` is `"sp"` for SP-lane entries (shared cache) or a sha256 hash
 * of the end user's identity for OBO-lane entries (per-user isolation) — see
 * {@link deriveMetricExecutorKey}.
 */
export function composeMetricCacheKey(input: {
  metricKey: string;
  source: string;
  measures: string[];
  dimensions?: string[];
  timeGrain?: string;
  timeDimension?: string;
  filter?: MetricFilter;
  format: string;
  executorKey: string;
  limit?: number;
}): string[] {
  const sortedMeasures = [...input.measures].sort();
  const sortedDimensions = [...(input.dimensions ?? [])].sort();
  const filterFingerprint =
    input.filter !== undefined ? canonicalizeFilter(input.filter) : "_";
  // `timeDimension` only changes the SQL when `timeGrain` is set (see
  // renderDimensionClause); keying on it otherwise would fork the cache on a
  // no-op field.
  const timeDimensionPart =
    input.timeGrain != null ? (input.timeDimension ?? "_") : "_";
  return [
    "metric",
    input.metricKey,
    input.source,
    input.format,
    sortedMeasures.join(","),
    sortedDimensions.join(","),
    input.timeGrain ?? "_",
    timeDimensionPart,
    filterFingerprint,
    typeof input.limit === "number" ? String(input.limit) : "_",
    input.executorKey,
  ];
}

/**
 * Derive the cache executor key from a metric registration's lane and the
 * caller's user identity.
 *
 * Returns `"sp"` for SP-lane entries (every caller shares the cache) and a
 * sha256 hex digest of the user identity for OBO-lane entries (each user gets
 * an isolated cache scope).
 *
 * The user identity is hashed — never stored verbatim — so the cache layer
 * (which logs keys at debug level and persists them in any cache backend)
 * never sees raw user emails or principal names. A stable, opaque token is
 * exactly what we need: same user → same key (so cache hits work), different
 * users → different keys (so isolation holds), and reverse lookup is
 * infeasible.
 *
 * For OBO requests without a resolvable identity (missing or whitespace-only
 * user id), throw `AuthenticationError.missingUserId()` rather than falling
 * back to a shared `"anonymous"` sentinel — distinct misconfigured callers
 * would otherwise collide into one cache scope and read each other's cached
 * results. The route computes this inside its try/catch, so the throw lands on
 * the canonical 401 envelope.
 */
export function deriveMetricExecutorKey(input: {
  lane: MetricLane;
  userIdentity?: string | null;
}): string {
  if (input.lane === "sp") {
    return "sp";
  }
  // OBO lane — hash the user identity so the raw email/principal never reaches
  // the cache layer. Missing/whitespace identity is a hard auth failure: the
  // alternative ("anonymous" sentinel) collides every misconfigured caller
  // into a single cache scope, so user A's results could leak to user B.
  const identity = input.userIdentity?.trim();
  if (!identity) {
    throw AuthenticationError.missingUserId();
  }
  return createHash("sha256").update(identity).digest("hex");
}

/**
 * Produce a deterministic string fingerprint of the filter tree.
 *
 * The fingerprint sorts predicates within each AND/OR group by
 * `(member, operator)` and recursively canonicalizes nested groups. Values are
 * included verbatim so cache entries differ when the filter targets different
 * values (`region in [EMEA]` vs `region in [APAC]` → different keys; `equals A`
 * vs `equals B` → different keys), while order-insensitive predicate lists
 * collapse to the same key.
 */
function canonicalizeFilter(node: MetricFilter): string {
  if (node === null || typeof node !== "object") {
    return "_";
  }

  if ("and" in node || "or" in node) {
    const groupKey = "and" in node ? "and" : "or";
    const children = (
      node as { and?: ReadonlyArray<MetricFilter> } & {
        or?: ReadonlyArray<MetricFilter>;
      }
    )[groupKey];

    if (!Array.isArray(children) || children.length === 0) {
      return `${groupKey}()`;
    }

    const sorted = sortFilterChildren(children);
    const childFingerprints = sorted.map(canonicalizeFilter);
    return `${groupKey}(${childFingerprints.join(",")})`;
  }

  // Leaf predicate. JSON.stringify every structural part — member, operator,
  // and each value (with its type) — so no content can be confused with a
  // separator. This matters now that `member` accepts the full delimited-
  // identifier grammar (it may contain "/", ".", etc.): a bare
  // `p(${member}/${operator}/...)` would let `member "a", op "b"` collide with
  // `member "a/b"` and fork/merge cache entries. Encoding the whole tuple as
  // JSON makes the fingerprint injective regardless of member/value content.
  const p = node as MetricPredicate;
  const valuesPart = (p.values ?? []).map((v) => [typeof v, v]);
  return `p(${JSON.stringify([p.member, p.operator, valuesPart])})`;
}
