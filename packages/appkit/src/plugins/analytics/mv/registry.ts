import path from "node:path";
// Canonical metric-source schema — the single source of truth for
// `config/metric-views/definitions.json`. Imported from the shared source
// directly (matching the type-generator's runtime, which pulls the zod-free
// `metric-fqn.ts` from the same tree) so the runtime and the generated JSON
// schema validate identically.
import { metricSourceSchema } from "../../../../../shared/src/schemas/metric-source";
import type { AppManager, DevFileReader, RequestLike } from "../../../app";
import { createLogger } from "../../../logging/logger";
import type { MetricRegistration } from "../types";
import { laneFromExecutor, METRIC_CONFIG_FILE } from "./constants";

const logger = createLogger("analytics:metric-views");

/**
 * Read and validate `config/metric-views/definitions.json` into a metric registry.
 *
 * Async and stateless — registration is a pure config parse with no warehouse
 * round-trip, no `DESCRIBE`, and no build-time metadata bundle.
 *
 * The file is read **through {@link AppManager.readMetricViewsConfig}** rather
 * than `node:fs` directly, so this path is dev-tunnel-aware (a `?dev` request
 * reads the developer's local file over the WebSocket tunnel) and inherits the
 * traversal guard. In production that's a plain `fs.readFile` under the hood,
 * so the semantics below are unchanged.
 *
 * Absent file -> empty registry (`null` from `readMetricViewsConfig`).
 * Malformed file -> 503 (throws).
 *
 * @param app - The {@link AppManager} that resolves + reads the config file.
 * @param req - Optional request object, used to detect dev mode.
 * @param devFileReader - Optional dev tunnel reader.
 */
export async function loadMetricRegistry(
  app: AppManager,
  req?: RequestLike,
  devFileReader?: DevFileReader,
): Promise<Record<string, MetricRegistration>> {
  const metricPath = path.join(app.metricViewsDir, METRIC_CONFIG_FILE);

  const raw = await app.readMetricViewsConfig(
    METRIC_CONFIG_FILE,
    req,
    devFileReader,
  );
  if (raw === null) {
    // Absent file (ENOENT in prod / dev-tunnel not-found) or a rejected
    // traversal path → dormant. Same as the old ENOENT branch.
    return Object.create(null);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse definitions.json at ${metricPath}: ${(err as Error).message}`,
    );
  }

  const result = metricSourceSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid definitions.json at ${metricPath}: ${issues}`);
  }

  // Null-prototype map so a metric key that collides with an inherited
  // `Object.prototype` member (`__proto__`, `constructor`, `toString`, …)
  // cannot resolve to a truthy non-registration at the `registry[key]` read
  // site and slip past the unknown-key 404.
  // Keys are still grammar-gated by `metricKeySchema` (identifier shape),
  // but the null prototype removes the whole class of inherited-property lookups as a boundary.
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
