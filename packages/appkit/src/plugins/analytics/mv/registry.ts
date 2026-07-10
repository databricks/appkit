import fs from "node:fs/promises";
import path from "node:path";
// Canonical metric-source schema — the single source of truth for
// `metric-views.json`. Imported from the shared source directly (matching the
// type-generator's runtime, which pulls the zod-free `metric-fqn.ts` from the
// same tree) so the runtime and the generated JSON schema validate identically.
import { metricSourceSchema } from "../../../../../shared/src/schemas/metric-source";
import { createLogger } from "../../../logging/logger";
import type { MetricRegistration } from "../types";
import { laneFromExecutor, METRIC_CONFIG_FILE, QUERIES_DIR } from "./constants";
import type { RegistryCacheSignature } from "./types";

const logger = createLogger("analytics:metric");

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
