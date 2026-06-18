import fs from "node:fs/promises";
import path from "node:path";
import type {
  MetricConfigResolution,
  MetricLane,
  MetricSourceConfig,
  ResolvedMetricEntry,
} from "./types";

const MV_CONFIG_FILE = "metric-views.json";

/**
 * {@link resolveMetricConfig} enforces these caps.
 */
const MAX_METRIC_VIEWS = 200;
const MAX_FQN_SEGMENT_LENGTH = 255;
const MAX_FQN_LENGTH = 767;

/**
 * Locale-independent comparator (UTF-16 code-unit order)
 * shared by BOTH artifact key orderings.
 *
 * @note important for caching correctness.
 */
export function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Read {@link MV_CONFIG_FILE} from a queries folder.
 *
 * Returns `null` if the file does not exist (the metric-view path is
 * additive — apps without metric-views.json must not be penalized). There is
 * deliberately no fallback to the legacy {@link MV_CONFIG_FILE} filename.
 *
 * Throws on JSON parse errors so misconfiguration surfaces loudly.
 */
export async function readMetricConfig(
  queryFolder: string,
): Promise<MetricSourceConfig | null> {
  const metricPath = path.join(queryFolder, MV_CONFIG_FILE);
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
      `Failed to parse metric-views.json at ${metricPath}: ${(err as Error).message}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Invalid metric-views.json at ${metricPath}: expected an object with a 'metricViews' map.`,
    );
  }

  return parsed as MetricSourceConfig;
}

/**
 * Validate a key against the JSON Schema's metricKey pattern. Kept
 * lightweight — the shared Zod schema ({@link metricSourceSchema} in `packages/shared/src/schemas/metric-source.ts`)
 * is the canonical contract for IDE/CI; this regex is identical to its
 * {@link metricKeySchema} in `packages/shared/src/schemas/metric-source.ts`.
 */
function isValidMetricKey(key: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key);
}

/**
 * Validate a UC FQN against the shared schema's source pattern.
 */
export function isValidFqn(fqn: string): boolean {
  return /^[a-zA-Z0-9_][a-zA-Z0-9_-]*\.[a-zA-Z0-9_][a-zA-Z0-9_-]*\.[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(
    fqn,
  );
}

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
        `Invalid top-level field "${field}" in metric-views.json: only '$schema' and 'metricViews' are allowed.`,
      );
    }
  }

  /**
   *  Default ONLY a genuinely-absent {@link MetricSourceConfig.metricViews}. `null` must fall through
   * to the type check below and throw — the canonical Zod schema ({@link metricSourceSchema}) rejects
   * `null`.
   */
  const metricViews =
    config.metricViews === undefined ? {} : config.metricViews;
  if (
    typeof metricViews !== "object" ||
    metricViews === null ||
    Array.isArray(metricViews)
  ) {
    throw new Error(
      `Invalid 'metricViews' in metric-views.json: expected an object map of metric entries.`,
    );
  }

  const entries: ResolvedMetricEntry[] = [];
  const sortedKeys = Object.keys(metricViews).sort(compareKeys);
  if (sortedKeys.length > MAX_METRIC_VIEWS) {
    throw new Error(
      `Invalid 'metricViews' in metric-views.json: ${sortedKeys.length} metric views exceed the maximum of ${MAX_METRIC_VIEWS}.`,
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

    if (!isValidFqn(entry.source)) {
      throw new Error(
        `Invalid metric source "${entry.source}" for "${key}": expected a three-part UC FQN <catalog>.<schema>.<metric_view>.`,
      );
    }

    const segments = entry.source.split(".");
    const segmentNames = ["catalog", "schema", "metric_view"];
    for (let i = 0; i < segments.length; i++) {
      if (segments[i].length > MAX_FQN_SEGMENT_LENGTH) {
        throw new Error(
          `Invalid metric source for "${key}": the ${segmentNames[i]} segment is ${segments[i].length} characters, exceeding the maximum of ${MAX_FQN_SEGMENT_LENGTH} per segment.`,
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
