import fs from "node:fs/promises";
import path from "node:path";
// Plain, zod-free value imports — single source of truth for the UC object-name
// grammar. The Zod schema (packages/shared/src/schemas/metric-source.ts) imports
// the SAME UC_FQN_PATTERN for its `source` .regex(...), so the runtime and the
// canonical schema validate identically without the type-generator pulling the
// shared Zod schema package into its runtime path (locked dependency-graph
// ruling — see the comment in ../cache.ts). The relative specifier resolves the
// shared source directly and drags in no zod.
import {
  MAX_UC_OBJECT_NAME_LENGTH,
  UC_FQN_PATTERN,
} from "../../../../shared/src/schemas/metric-fqn";
import type {
  MetricConfigResolution,
  MetricLane,
  MetricSourceConfig,
  ResolvedMetricEntry,
} from "./types";

const MV_CONFIG_FILE = "definitions.json";

/**
 * Safety cap on declared metric views — a typo / DoS guard, NOT a Unity Catalog
 * limit. Enforced by {@link resolveMetricConfig}.
 */
const MAX_METRIC_VIEWS = 200;
/** Per-segment cap = UC's object-name length limit (255). */
const MAX_FQN_SEGMENT_LENGTH = MAX_UC_OBJECT_NAME_LENGTH;
/** Whole-FQN cap: three max-length segments plus the two separating dots. */
const MAX_FQN_LENGTH = MAX_FQN_SEGMENT_LENGTH * 3 + 2;
/** A metric view FQN is exactly catalog.schema.metric_view. */
const FQN_SEGMENT_NAMES = ["catalog", "schema", "metric_view"] as const;
const FQN_SEGMENT_COUNT = FQN_SEGMENT_NAMES.length;

/**
 * Locale-independent comparator (UTF-16 code-unit order) for metric-view key
 * ordering. Plain `sort()` is locale-sensitive, so keys could order differently
 * across environments and invalidate the cache hash — this keeps the ordering
 * stable everywhere.
 */
function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Read {@link MV_CONFIG_FILE} from a metric-views folder
 * (`config/metric-views/`).
 *
 * Returns `null` if the file does not exist (the metric-view path is
 * additive — apps without definitions.json must not be penalized). There is
 * deliberately no fallback to a legacy filename.
 *
 * Throws on JSON parse errors so misconfiguration surfaces loudly.
 */
export async function readMetricConfig(
  metricViewsFolder: string,
): Promise<MetricSourceConfig | null> {
  const metricPath = path.join(metricViewsFolder, MV_CONFIG_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(metricPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse definitions.json at ${metricPath}: ${(err as Error).message}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Invalid definitions.json at ${metricPath}: expected an object with a 'metricViews' map.`,
    );
  }

  return parsed as MetricSourceConfig;
}

/**
 * Validate a key against the JSON Schema's metricKey pattern. Kept
 * lightweight — the shared Zod schema ({@link metricSourceSchema}) is the
 * canonical contract for IDE/CI; this regex is identical to its
 * {@link metricKeySchema}.
 */
function isValidMetricKey(key: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key);
}

// `resolveMetricConfig` re-derives the three-part UC FQN checks inline (rather
// than calling a shared predicate) so it can emit specific, staged error
// messages: arity, per-segment charset, per-segment length.

/**
 * Field allowlists enforced by {@link resolveMetricConfig}.
 */
const ALLOWED_TOP_LEVEL_FIELDS = new Set(["$schema", "metricViews"]);
const ALLOWED_ENTRY_FIELDS = new Set(["source", "executor"]);

/**
 * Resolve the {@link MetricSourceConfig.metricViews} map into a flat list of entries.
 */
export function resolveMetricConfig(
  config: MetricSourceConfig,
): MetricConfigResolution {
  for (const field of Object.keys(config)) {
    if (!ALLOWED_TOP_LEVEL_FIELDS.has(field)) {
      throw new Error(
        `Invalid top-level field "${field}" in definitions.json: only '$schema' and 'metricViews' are allowed.`,
      );
    }
  }

  // Default to {} only when metricViews is genuinely absent. A `null` must fall
  // through to the type check below and throw — the canonical Zod schema rejects
  // null.
  const metricViews =
    config.metricViews === undefined ? {} : config.metricViews;
  if (
    typeof metricViews !== "object" ||
    metricViews === null ||
    Array.isArray(metricViews)
  ) {
    throw new Error(
      `Invalid 'metricViews' in definitions.json: expected an object map of metric entries.`,
    );
  }

  const entries: ResolvedMetricEntry[] = [];
  const sortedKeys = Object.keys(metricViews).sort(compareKeys);
  if (sortedKeys.length > MAX_METRIC_VIEWS) {
    throw new Error(
      `Invalid 'metricViews' in definitions.json: ${sortedKeys.length} metric views exceed the maximum of ${MAX_METRIC_VIEWS}.`,
    );
  }
  for (const key of sortedKeys) {
    if (!isValidMetricKey(key)) {
      throw new Error(
        `Invalid metric key "${key}" in metricViews: must match /^[a-zA-Z_][a-zA-Z0-9_]*$/.`,
      );
    }

    const entry = metricViews[key];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(
        `Invalid metric entry "${key}": expected an object with a 'source' field.`,
      );
    }

    for (const field of Object.keys(entry)) {
      if (!ALLOWED_ENTRY_FIELDS.has(field)) {
        throw new Error(
          `Invalid field "${field}" on metric entry "${key}": only 'source' and 'executor' are allowed at v1.`,
        );
      }
    }

    if (typeof entry.source !== "string" || entry.source.trim() === "") {
      throw new Error(
        `Invalid metric entry "${key}": 'source' must be a non-empty string.`,
      );
    }

    if (entry.source.length > MAX_FQN_LENGTH) {
      throw new Error(
        `Invalid metric source for "${key}": FQN is ${entry.source.length} characters, exceeding the maximum of ${MAX_FQN_LENGTH}.`,
      );
    }

    // Staged, specific validation against the UC object-name grammar
    // (UC_FQN_PATTERN — shared with the canonical Zod schema). Reported in
    // order of increasing specificity so the message names the exact problem.
    const segments = entry.source.split(".");

    // Arity: exactly catalog.schema.metric_view. A wrong part count almost
    // always means a name contains a dot — which the dotted `source` cannot
    // express, since every dot is a segment boundary.
    if (segments.length !== FQN_SEGMENT_COUNT) {
      throw new Error(
        `Invalid metric source "${entry.source}" for "${key}": expected a three-part UC FQN <catalog>.<schema>.<metric_view> (got ${segments.length} dot-separated part${segments.length === 1 ? "" : "s"}). A catalog, schema, or metric view name cannot itself contain a dot.`,
      );
    }

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const segmentName = FQN_SEGMENT_NAMES[i];

      // Empty part: a leading/trailing/double dot (e.g. "a..c", ".b.c").
      if (segment.length === 0) {
        throw new Error(
          `Invalid metric source "${entry.source}" for "${key}": the ${segmentName} part is empty. A three-part UC FQN needs a non-empty name in each position: <catalog>.<schema>.<metric_view>.`,
        );
      }

      // Length cap (UC: object names are at most 255 characters).
      if (segment.length > MAX_FQN_SEGMENT_LENGTH) {
        throw new Error(
          `Invalid metric source for "${key}": the ${segmentName} segment is ${segment.length} characters, exceeding the maximum of ${MAX_FQN_SEGMENT_LENGTH} per segment.`,
        );
      }

      // Character set: must be a valid UC object name (the FQN is always
      // backtick-quoted before it reaches SQL, so UC's *delimited* identifier
      // rules apply — anything but space, '/', and control characters).
      if (!UC_FQN_PATTERN.test(segment)) {
        throw new Error(
          `Invalid metric source "${entry.source}" for "${key}": the ${segmentName} part "${segment}" contains a character Unity Catalog does not allow in an object name (no spaces, '/', or control characters).`,
        );
      }
    }

    const executor = entry.executor;
    if (
      executor !== undefined &&
      executor !== "app_service_principal" &&
      executor !== "user"
    ) {
      throw new Error(
        `Invalid executor "${String(executor)}" on metric entry "${key}": must be "app_service_principal" or "user".`,
      );
    }

    const lane: MetricLane = executor === "user" ? "obo" : "sp";

    entries.push({ key, source: entry.source, lane });
  }

  return { entries };
}
