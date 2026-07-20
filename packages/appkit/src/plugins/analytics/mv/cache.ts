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
