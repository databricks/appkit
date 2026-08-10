import { createHash } from "node:crypto";
import { AuthenticationError } from "../../../errors";
import type { MetricFilter, MetricLane, MetricPredicate } from "../types";
import { sortFilterChildren } from "./formatters";
import type { MetricCacheKeyInput } from "./types";

export function composeMetricCacheKey(input: MetricCacheKeyInput): string[] {
  const sortedMeasures = [...input.measures].sort();
  const sortedDimensions = [...(input.dimensions ?? [])].sort();
  const filterFingerprint =
    input.filter !== undefined ? canonicalizeFilter(input.filter) : "_";
  // `timeDimension` only changes the SQL when `timeGrain` is set (see renderDimensionClause)
  const timeDimensionPart =
    input.timeGrain != null ? (input.timeDimension ?? "_") : "_";
  // `orderBy` is NOT sorted (unlike measures/dimensions) because the sequence is
  // semantic: `ORDER BY a, b` returns different rows under LIMIT than `ORDER BY b, a`.
  // Sorting it would incorrectly collapse two genuinely different queries onto the same
  // cache key. We still normalize absent directions to "ASC" for cache key equality.
  //
  // Known, accepted over-splitting: a request whose `orderBy` merely restates the
  // dimensions the `limit` tie-breaker would have appended renders SQL identical to
  // one that omits `orderBy`, yet keys differently. Collapsing those would mean
  // replicating `renderOrderByClause`'s completion logic here — two copies of the
  // rule to keep in sync, where drift produces a key COLLISION (wrong order served
  // from cache). An extra cache entry is the safe side of that trade; do not "fix"
  // this by canonicalizing.
  const orderByPart =
    input.orderBy !== undefined && input.orderBy.length > 0
      ? JSON.stringify(
          input.orderBy.map((o) => [o.field, o.direction ?? "ASC"]),
        )
      : "_";
  return [
    "metric",
    input.metricKey,
    input.source,
    input.format,
    // JSON-encode (not raw `.join(",")`): a comma is a legal identifier
    // character (`isValidColumnName` rejects only control chars / newlines), so
    // joining on `,` would collapse `["a,b"]` and `["a","b"]` to the same key
    // element despite rendering different SQL. JSON quoting keeps the key
    // one-to-one with the generated SQL — the same encoding `canonicalizeFilter`
    // uses for predicate members below.
    JSON.stringify(sortedMeasures),
    JSON.stringify(sortedDimensions),
    input.timeGrain ?? "_",
    timeDimensionPart,
    filterFingerprint,
    typeof input.limit === "number" ? String(input.limit) : "_",
    orderByPart,
    input.executorKey,
  ];
}

export function deriveMetricExecutorKey(input: {
  lane: MetricLane;
  userIdentity?: string | null;
}): string {
  if (input.lane === "sp") {
    return "sp";
  }
  const identity = input.userIdentity?.trim();
  if (!identity) {
    throw AuthenticationError.missingUserId();
  }
  return createHash("sha256").update(identity).digest("hex");
}

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

  const p = node as MetricPredicate;
  const valuesPart = (p.values ?? []).map((v) => [typeof v, v]);
  return `p(${JSON.stringify([p.member, p.operator, valuesPart])})`;
}
