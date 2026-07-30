import fs from "node:fs/promises";
import path from "node:path";
import { WorkspaceClient } from "@databricks/sdk-experimental";
import dotenv from "dotenv";
import pc from "picocolors";
import { createLogger } from "../logging/logger";
import {
  CACHE_VERSION,
  loadMetricCache,
  type MetricCacheEntry,
  metricCacheHash,
} from "./cache";
import { renderCacheHeader, resolveHeaderTimestamp } from "./embedded-cache";
import { getErrorDiagnostic, isConnectivityError } from "./errors";
import {
  migrateProjectConfig,
  removeOldGeneratedTypes,
  resolveProjectRoot,
} from "./migration";
import { readMetricConfig, resolveMetricConfig } from "./mv-registry/config";
import { createWorkspaceDescribeFetcher } from "./mv-registry/describe";
import {
  generateMetricTypeDeclarationsFromMembers,
  type MetricMember,
  renderMetricEntry,
} from "./mv-registry/render-types";
import { emptyMetricSchema, syncMetrics } from "./mv-registry/sync";
import type {
  DescribeFetcher,
  MetricColumnMetadata,
  MetricLane,
  MetricSchema,
  MetricSyncFailure,
  MetricSyncResult,
} from "./mv-registry/types";
import { decidePreflight, type PreflightMode } from "./preflight";
import { generateQueriesFromDescribe } from "./query-registry";
import { generateServingTypes as generateServingTypesImpl } from "./serving/generator";
import type { QueryFatalError, QuerySchema, QuerySyntaxError } from "./types";
import {
  getWarehouseState,
  startWarehouse,
  type WarehouseState,
  waitUntilRunning,
} from "./warehouse-status";

dotenv.config();

const logger = createLogger("type-generator");

/**
 * Upper bound (~5 min) on how long the Metric Views path's `blocking`-mode preflight
 * waits for a warehouse to reach RUNNING. Mirrors the query path's (unexported)
 * `PREFLIGHT_WAIT_MAX_MS` in query-registry.ts.
 */
const MV_PREFLIGHT_WAIT_MAX_MS = 300_000;

type TypegenFailure = QuerySyntaxError | QueryFatalError;

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return count === 1 ? singular : pluralForm;
}

function formatFailureRows(
  label: string,
  queries: TypegenFailure[],
  color: (value: string) => string,
) {
  if (queries.length === 0) return [];

  // Group by message so a shared failure — e.g. a warehouse-level fatal that
  // hits every query identically — prints once instead of repeating per row.
  const byMessage = new Map<string, string[]>();
  for (const { name, message } of queries) {
    const names = byMessage.get(message);
    if (names) names.push(name);
    else byMessage.set(message, [name]);
  }

  const maxNameLen = Math.max(...queries.map((query) => query.name.length));
  const tag = color(label.padEnd(7));
  const rows: string[] = [];
  for (const [message, names] of byMessage) {
    if (names.length === 1) {
      rows.push(
        `  ${tag}  ${pc.bold(names[0].padEnd(maxNameLen))}  ${pc.dim(message)}`,
      );
      continue;
    }
    // Shared message → print it once, then list the affected query names.
    rows.push(
      `  ${tag}  ${pc.dim(message)} ${pc.dim(`(${names.length} ${plural(names.length, "query", "queries")})`)}`,
    );
    rows.push(
      `           ${names.map((name) => pc.bold(name)).join(pc.dim(", "))}`,
    );
  }
  return rows;
}

function formatTypegenFailureMessage(options: {
  syntaxErrors: QuerySyntaxError[];
  fatalErrors?: QueryFatalError[];
  warehouseId?: string;
  title: string;
  causes: string[];
  nextStep: string;
}) {
  const { syntaxErrors, fatalErrors = [], warehouseId, title } = options;
  const total = syntaxErrors.length + fatalErrors.length;
  const separator = pc.dim("─".repeat(60));
  const warehouse = warehouseId
    ? ` against ${pc.dim(`warehouse ${warehouseId}`)}`
    : "";

  return [
    `  ${pc.bold(pc.red("Type generation failed"))}`,
    `  ${separator}`,
    `  ${title}: ${total} ${plural(total, "query", "queries")} could not be described${warehouse}.`,
    `  AppKit wrote generated types with ${pc.bold("result: unknown")} for the failed ${plural(total, "query", "queries")}.`,
    "",
    ...formatFailureRows("SQL ERR", syntaxErrors, pc.red),
    ...(syntaxErrors.length > 0 && fatalErrors.length > 0 ? [""] : []),
    ...formatFailureRows("FATAL", fatalErrors, pc.red),
    "",
    `  ${pc.bold("Common causes")}`,
    ...options.causes.map((cause) => `  - ${cause}`),
    "",
    `  ${pc.bold("Next step")}`,
    `  ${options.nextStep}`,
  ].join("\n");
}

/**
 * Thrown when one or more queries fail `DESCRIBE QUERY` against a *reachable*
 * warehouse — i.e. genuine SQL errors (bad table, syntax, incompatible type),
 * as opposed to a connectivity failure (warehouse unreachable), which degrades
 * silently. Whether this is fatal is the caller's decision: the Vite plugin and
 * CLI fail the build in production and warn-only in development.
 */
export class TypegenSyntaxError extends Error {
  readonly queries: QuerySyntaxError[];
  readonly fatalQueries: QueryFatalError[];

  constructor(
    queries: QuerySyntaxError[],
    warehouseId?: string,
    fatalQueries: QueryFatalError[] = [],
  ) {
    super(
      formatTypegenFailureMessage({
        syntaxErrors: queries,
        fatalErrors: fatalQueries,
        warehouseId,
        title: "DESCRIBE QUERY failed",
        causes: [
          "SQL syntax errors",
          "missing tables or views",
          "warehouse format incompatibilities",
        ],
        nextStep: warehouseId
          ? `Run each SQL ERR query directly in a Databricks SQL editor against warehouse ${pc.bold(warehouseId)}.`
          : "Run each SQL ERR query directly in a Databricks SQL editor.",
      }),
    );
    this.name = "TypegenSyntaxError";
    this.queries = queries;
    this.fatalQueries = fatalQueries;
  }
}

/**
 * Thrown when DESCRIBE QUERY could not be requested because of a non-SQL fatal
 * setup/request problem, such as missing permissions, invalid warehouse IDs, or
 * malformed SDK configuration. Like TypegenSyntaxError, this is thrown only
 * after the declaration file has been written with `result: unknown` entries.
 */
export class TypegenFatalError extends Error {
  readonly queries: QueryFatalError[];

  constructor(queries: QueryFatalError[], warehouseId?: string) {
    super(
      formatTypegenFailureMessage({
        syntaxErrors: [],
        fatalErrors: queries,
        warehouseId,
        title: "DESCRIBE QUERY could not be requested",
        causes: [
          "missing warehouse permissions",
          "invalid warehouse ID",
          "authentication failure",
          "SDK configuration errors",
        ],
        nextStep: warehouseId
          ? `Verify access to warehouse ${pc.bold(warehouseId)} and rerun type generation.`
          : "Verify warehouse access and rerun type generation.",
      }),
    );
    this.name = "TypegenFatalError";
    this.queries = queries;
  }
}

/**
 * Generate type declarations for QueryRegistry
 * Create the d.ts file from the plugin routes and query schemas
 * @param querySchemas - the list of query schemas
 * @returns - the type declarations as a string
 */
function generateTypeDeclarations(
  querySchemas: QuerySchema[] = [],
  priorSource = "",
): string {
  const queryEntries = querySchemas
    .map(({ name, type }) => {
      const indentedType = type
        .split("\n")
        .map((line, i) => (i === 0 ? line : `    ${line}`))
        .join("\n");
      return `    ${name}: ${indentedType}`;
    })
    .join(";\n");

  const querySection = queryEntries ? `\n${queryEntries};\n  ` : "";

  // The cache header records one hash per query that was successfully generated
  // (a cache hit or a fresh successful describe). Degraded / `unknown` schemas
  // carry no hash and are omitted, so they re-read as a MISS next pass.
  const headerEntries = querySchemas
    .filter((s): s is QuerySchema & { hash: string } => Boolean(s.hash))
    .map((s) => ({ name: s.name, hash: s.hash }));
  const header = renderCacheHeader({
    version: CACHE_VERSION,
    explainer:
      "A matching source hash skips the warehouse DESCRIBE on build & deploy.",
    entries: headerEntries,
    // Preserve the prior timestamp when nothing changed → no git churn.
    timestamp: resolveHeaderTimestamp(priorSource, headerEntries),
  });

  return `${header}import "@databricks/appkit-ui/react";
import type { SQLTypeMarker, SQLStringMarker, SQLNumberMarker, SQLBooleanMarker, SQLBinaryMarker, SQLDateMarker, SQLTimestampMarker } from "@databricks/appkit-ui/js";

declare module "@databricks/appkit-ui/react" {
  interface QueryRegistry {${querySection}}
}
`;
}

/**
 * Status-only probe for the metric-view gate in {@link generateFromEntryPoint}
 *
 * Uses {@link getWarehouseState} (`warehouses.get`) —
 * a read-only GET that can never start the warehouse
 *
 * Takes the lazy client *getter* so the probe also absorbs client construction failure.
 * A connectivity blip returns `undefined`, which the gate reads as transient not-running;
 * a deterministic failure (auth, bad id) is re-thrown so the gate can classify it
 * fatal rather than silently degrading.
 */
async function probeWarehouseState(
  getClient: () => WorkspaceClient,
  warehouseId: string,
): Promise<WarehouseState | undefined> {
  try {
    return await getWarehouseState(getClient(), warehouseId);
  } catch (err) {
    // Connectivity blip → undefined (gate degrades, retries next pass). A
    // deterministic failure (auth, bad warehouse id, client construction) must
    // not masquerade as not-running — re-throw so the gate pins it fatal, the
    // same split the query path's preflight makes.
    if (isConnectivityError(err)) return undefined;
    throw err;
  }
}

/**
 * Entry point for generating type declarations from all imported files
 * @param options - the options for the generation
 * @param options.entryPoint - the entry point file
 * @param options.outFile - the output file
 * @param options.noCache - skip the typegen cache entirely: every query is
 *   re-described, and the metric path ignores its cached schemas (every
 *   configured key becomes describe-needed) and overwrites the cache's
 *   `metrics` section with this pass's results.
 * @param options.mode - preflight policy (see {@link PreflightMode}), default
 *   `"non-blocking"`. For queries, `"non-blocking"` never touches the
 *   warehouse. For metric views it makes one status-only probe and DESCRIBEs
 *   only when the warehouse is already RUNNING, otherwise emits permissive
 *   degraded types immediately. `"blocking"` waits for / starts the warehouse
 *   first, failing the build only for a deleted/deleting one.
 * @param options.metricViewsFolder - folder that holds `definitions.json`
 *   (`<root>/config/metric-views`). Optional and independent of `queryFolder`:
 *   metric-view types generate whenever this folder holds a config, even if the
 *   app has no `config/queries`. When omitted it defaults to a sibling
 *   `metric-views` directory of `queryFolder` (so query-only callers keep
 *   working); when neither is given, the metric path is skipped.
 * @param options.mvOutFile - optional output file for the MetricRegistry
 *   augmentation. Defaults to a sibling `metric-views.d.ts` file under the same
 *   directory as `outFile`. Skipped entirely if `definitions.json` is absent.
 * @param options.metricFetcher - optional DescribeFetcher used by
 *   {@link syncMetrics} (tests inject a mock; production lazily builds a
 *   default WorkspaceClient-backed one). An injected fetcher always runs: it
 *   hits no warehouse, so it bypasses both the non-blocking gate and the
 *   blocking preflight.
 */
export async function generateFromEntryPoint(options: {
  outFile: string;
  queryFolder?: string;
  metricViewsFolder?: string;
  warehouseId: string;
  noCache?: boolean;
  mode?: PreflightMode;
  mvOutFile?: string;
  metricFetcher?: DescribeFetcher;
}) {
  const {
    outFile,
    queryFolder,
    warehouseId,
    noCache,
    mode = "non-blocking",
    mvOutFile,
    metricFetcher,
  } = options;

  // Metric config lives in `config/metric-views/`, a sibling of the queries
  // folder. Prefer the explicit option; otherwise derive the sibling of
  // `queryFolder` so callers that pass only `queryFolder` keep emitting metric
  // types. Undefined when neither is given → the metric path stays dormant.
  const metricViewsFolder =
    options.metricViewsFolder ??
    (queryFolder ? path.resolve(queryFolder, "..", "metric-views") : undefined);

  const projectRoot = resolveProjectRoot(outFile);

  logger.debug("Starting type generation...");

  let queryRegistry: QuerySchema[] = [];
  let syntaxErrors: QuerySyntaxError[] = [];
  let fatalErrors: QueryFatalError[] = [];
  if (queryFolder) {
    const result = await generateQueriesFromDescribe(queryFolder, warehouseId, {
      noCache,
      mode,
      cacheFile: outFile,
    });
    queryRegistry = result.schemas;
    syntaxErrors = result.syntaxErrors ?? [];
    fatalErrors = result.fatalErrors ?? [];
  }

  // Read the prior committed file (if any) so an unchanged run preserves its
  // generation timestamp → the .d.ts stays byte-identical (no git churn).
  const priorOut = await fs.readFile(outFile, "utf-8").catch(() => "");
  const typeDeclarations = generateTypeDeclarations(queryRegistry, priorOut);

  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, typeDeclarations, "utf-8");

  // Metric-view types: emit whenever a metric-views folder is resolved (gated
  // on the metric config's own dir, NOT the queries folder — an app can declare
  // metric views without any `.sql` queries). `syncMetricViewsTypes` still
  // returns `noConfig` when the folder holds no `definitions.json`.
  if (metricViewsFolder) {
    const mvFile =
      mvOutFile ?? path.join(path.dirname(outFile), METRIC_TYPES_FILE);

    let mvResult: SyncMetricViewsTypesResult;
    try {
      mvResult = await syncMetricViewsTypes({
        metricViewsFolder,
        warehouseId,
        metricOutFile: mvFile,
        cache: !noCache,
        metricFetcher,
        mode,
      });
    } catch (configError) {
      // syncMetricViewsTypes only throws for a malformed definitions.json — re-throw as a message-only TypegenFatalError.
      throw new TypegenFatalError(
        [
          {
            name: "config/metric-views/definitions.json",
            message: getErrorDiagnostic(configError),
          },
        ],
        warehouseId,
      );
    }

    // Deleted/deleting-warehouse fatal preflight (blocking mode only);
    // empty (no-op) when definitions.json is absent or in non-blocking mode.
    for (const fe of mvResult.fatalErrors) {
      fatalErrors.push(fe);
    }

    // Blocking (`--wait` / prod Vite) escalates per-key DESCRIBE failures — a bad or unreachable source, i.e. a config error
    // to build failures so the end-of-run throw fails after the writes.
    if (mode === "blocking") {
      for (const failure of mvResult.failures) {
        fatalErrors.push({
          name: failure.key,
          message: `metric view ${failure.key} (${failure.source}) could not be described: ${failure.reason}`,
        });
      }
    }
  }

  await removeOldGeneratedTypes(projectRoot, "appKitTypes.d.ts");
  await migrateProjectConfig(projectRoot);

  // Types are always written above — including `result: unknown` for any Metric View that could not be described.
  if (syntaxErrors.length > 0) {
    throw new TypegenSyntaxError(syntaxErrors, warehouseId, fatalErrors);
  }
  if (fatalErrors.length > 0) {
    throw new TypegenFatalError(fatalErrors, warehouseId);
  }

  logger.debug("Type generation complete!");
}

/**
 * Result of a {@link syncMetricViewsTypes} run, returned to the caller (the CLI
 * directly, or {@link generateFromEntryPoint} which delegates to it) so it can
 * report what happened and decide its exit code.
 */
export interface SyncMetricViewsTypesResult {
  metricOutFile?: string;
  schemas: MetricSchema[];
  failures: MetricSyncFailure[];
  /**
   * `true` when no `definitions.json` was found in the metric-views folder, so
   * nothing was synced.
   */
  noConfig: boolean;
  /**
   * Per-key fatal preflight errors (empty except in the `blocking`-mode
   * deleted/deleting-warehouse and deterministic-preflight-failure cases). The
   * artifacts are still written; {@link generateFromEntryPoint} surfaces these
   * by throwing {@link TypegenFatalError} after the writes. A `"describe-now"`
   * run sets no blocking preflight, so for that mode this is always empty.
   */
  fatalErrors: Array<{ name: string; message: string }>;
}

/**
 * Unified metric-view type-generation pipeline behind {@link
 * generateFromEntryPoint}'s metric section (which forwards its
 * `"non-blocking"`/`"blocking"` mode). Also directly callable with the default
 * `"describe-now"` mode for a focused, always-converge metric refresh.
 *
 *
 * @param options.metricViewsFolder - folder that holds `definitions.json` (`<root>/config/metric-views`).
 * @param options.warehouseId - SQL warehouse used for `DESCRIBE TABLE EXTENDED`.
 * @param options.metricOutFile - output path for the MetricRegistry `.d.ts`.
 * @param options.cache - cache toggle, default ON. Only `cache === false` disables it (so `undefined`/`true` keep caching).
 * @param options.metricFetcher - optional injected {@link DescribeFetcher}
 * @param options.mode - preflight/gate policy, default `"describe-now"`.
 */
export async function syncMetricViewsTypes(options: {
  metricViewsFolder: string;
  warehouseId: string;
  metricOutFile: string;
  cache?: boolean;
  metricFetcher?: DescribeFetcher;
  mode?: "describe-now" | "non-blocking" | "blocking";
}): Promise<SyncMetricViewsTypesResult> {
  const {
    metricViewsFolder,
    warehouseId,
    metricOutFile,
    cache: cacheEnabled,
    metricFetcher,
    mode = "describe-now",
  } = options;

  // Only `cache === false` disables caching; `undefined`/`true` keep it on.
  const noCache = cacheEnabled === false;

  const mvConfig = await readMetricConfig(metricViewsFolder);
  if (!mvConfig) {
    // No definitions.json — additive path stays dormant. The CLI turns this
    // into a friendly "nothing to sync" message and exits 0;
    // generateFromEntryPoint simply ignores `noConfig`.
    return { schemas: [], failures: [], fatalErrors: [], noConfig: true };
  }

  const resolution = resolveMetricConfig(mvConfig);

  const fatalErrors: Array<{ name: string; message: string }> = [];

  // Reconstruct the metric cache from the committed metric-views.d.ts (its
  // header hashes + body member blocks). Missing/old file → empty (all MISS).
  const metricCache = noCache
    ? {
        version: CACHE_VERSION,
        entries: {} as Record<string, MetricCacheEntry>,
      }
    : await loadMetricCache(metricOutFile);

  // Partition BEFORE any gate/preflight decision: a hit (a hash-matching cached
  // entry) is served from cache no matter what the warehouse is doing. Only
  // non-degraded members are ever recorded in the header (see the renderer), so
  // a committed hit is by construction a good result. Everything else (new,
  // edited, or absent) is eligible for DESCRIBE, so a fully-warm pass makes zero
  // warehouse calls and constructs zero clients. Mirrors the query path.
  //
  // `hitMembers` holds the previously-rendered member string, reused verbatim so
  // the output round-trips byte-identically without reconstructing a MetricSchema.
  const hitMembers = new Map<string, string>();
  const describeNeeded: typeof resolution.entries = [];
  for (const entry of resolution.entries) {
    const prior = metricCache.entries[entry.key];
    if (
      prior !== undefined &&
      prior.hash === metricCacheHash(entry.source, entry.lane)
    ) {
      hitMembers.set(entry.key, prior.member);
    } else {
      describeNeeded.push(entry);
    }
  }

  let mvClient: WorkspaceClient | undefined;
  const getMvClient = (): WorkspaceClient => {
    mvClient ??= new WorkspaceClient({});
    return mvClient;
  };

  // Blocking-mode preflight: ensure the warehouse is running before the MV DESCRIBE
  // batch (probe → decide → wait / start+wait; only DELETED/DELETING is fatal). Two softenings vs the query preflight: a failed probe and a timed-out wait are NOT fatal here — we fall through to syncMetrics, which classifies a still-not-ready warehouse as degraded rather than failing the build. Skipped for `describe-now`/`non-blocking` (only `mode === "blocking"` enters here).
  let preflightFatalMessage: string | undefined;
  if (
    mode === "blocking" &&
    metricFetcher === undefined &&
    describeNeeded.length > 0
  ) {
    try {
      const state = await getWarehouseState(getMvClient(), warehouseId);
      const decision = decidePreflight(state, mode);
      if (decision === "fatal") {
        preflightFatalMessage = `warehouse ${warehouseId} is ${state}`;
      } else if (decision === "startWaitProceed") {
        // treatStoppedAsTransient rides out the stale pre-start STOPPED/STOPPING
        // reading, same as the query preflight.
        await startWarehouse(getMvClient(), warehouseId);
        const settled = await waitUntilRunning(getMvClient(), warehouseId, {
          maxMs: MV_PREFLIGHT_WAIT_MAX_MS,
          treatStoppedAsTransient: true,
        });
        if (settled !== "RUNNING") {
          // With treatStoppedAsTransient, a non-RUNNING resolve is exactly
          // DELETED/DELETING — the warehouse was deleted while we waited.
          preflightFatalMessage = `warehouse ${warehouseId} is ${settled}`;
        }
      } else if (decision === "waitThenProceed") {
        const settled = await waitUntilRunning(getMvClient(), warehouseId, {
          maxMs: MV_PREFLIGHT_WAIT_MAX_MS,
        });
        if (settled === "DELETED" || settled === "DELETING") {
          // Deleted mid-wait: fatal.
          preflightFatalMessage = `warehouse ${warehouseId} is ${settled}`;
        }
      }
    } catch (err) {
      // Connectivity blip: fall through to syncMetrics, whose DESCRIBEs degrade
      // a not-ready / unreachable warehouse rather than throwing.
      if (!isConnectivityError(err)) {
        preflightFatalMessage = `warehouse ${warehouseId}: ${getErrorDiagnostic(err)}`;
      }
    }
  }

  let gateState: WarehouseState | undefined;
  let describeNow =
    metricFetcher !== undefined ||
    mode !== "non-blocking" ||
    describeNeeded.length === 0;
  if (!describeNow) {
    try {
      gateState = await probeWarehouseState(getMvClient, warehouseId);
    } catch (err) {
      preflightFatalMessage = `warehouse ${warehouseId}: ${getErrorDiagnostic(err)}`;
    }
    describeNow = gateState === "RUNNING";
  }

  let described: MetricSchema[];
  let failures: MetricSyncFailure[] = [];
  if (preflightFatalMessage !== undefined) {
    // Fatal preflight (deleted/deleting warehouse): fail like the query path —
    // skip DESCRIBE, emit degraded schemas so both artifacts are still written,
    // and record one fatal error per describe-needed key (cache hits are
    // unaffected). The caller surfaces them after the writes. The degraded
    // schemas are not cached (see the write block), so a later pass re-probes.
    described = describeNeeded.map(emptyMetricSchema);
    for (const entry of describeNeeded) {
      fatalErrors.push({ name: entry.key, message: preflightFatalMessage });
    }
  } else if (describeNeeded.length === 0) {
    // Nothing left to describe — every configured key was a cache hit.
    // syncMetrics would be a no-op (and building its fetcher would construct a
    // client for nothing); artifacts regenerate from cache.
    described = [];
  } else if (describeNow) {
    const fetcher =
      metricFetcher ??
      createWorkspaceDescribeFetcher(getMvClient(), warehouseId);
    ({ schemas: described, failures } = await syncMetrics(
      { entries: describeNeeded },
      fetcher,
    ));

    // Surface DESCRIBE failures loudly: a misconfigured definitions.json would
    // otherwise silently ship an empty entry that the runtime fail-closed gate
    // 503s in production. syncMetrics is log-free; this caller is the single
    // owner of failure logging.
    if (failures.length > 0) {
      for (const f of failures) {
        logger.warn(
          "metric sync failed for %s (%s): %s",
          f.key,
          f.source,
          f.reason,
        );
      }
    }

    // Degraded-but-not-failed keys: the warehouse answered with a non-terminal
    // state (stopped / cold-starting), so their schemas are unknown.
    const failedKeys = new Set(failures.map((f) => f.key));
    const degradedKeys = described
      .filter((s) => s.degraded && !failedKeys.has(s.key))
      .map((s) => s.key);
    if (degradedKeys.length > 0) {
      logger.info(
        "Warehouse %s did not return schemas for %d metric view(s) (%s) — wrote degraded metric types (permissive); they will refresh once the warehouse is available.",
        warehouseId,
        degradedKeys.length,
        degradedKeys.join(", "),
      );
    }
  } else {
    // Un-probed DESCRIBEs deliberately skipped, not failures: emit each
    // describe-needed key as a degraded schema so both artifacts exist; cache
    // hits keep serving last-known-good.
    described = describeNeeded.map(emptyMetricSchema);
    logger.info(
      "Warehouse %s is not running — wrote degraded metric types (permissive) for %d metric view(s) (%s); they will refresh once the warehouse is available.",
      warehouseId,
      describeNeeded.length,
      describeNeeded.map((e) => e.key).join(", "),
    );
  }

  // Freshly-described schemas by key (one per describe-needed entry, in order).
  const describedByKey = new Map<string, MetricSchema>();
  for (const schema of described) {
    describedByKey.set(schema.key, schema);
  }

  // Assemble the file members in config order. A cache hit reuses its committed
  // member string verbatim (round-trips byte-identically without reconstructing
  // a MetricSchema); a describe-needed key renders freshly. Only non-degraded
  // members record a header hash, so a degraded key re-reads as a MISS next
  // pass. Stale keys drop out implicitly — only configured entries are emitted,
  // so the committed cache is rewritten to exactly the current config.
  const members: MetricMember[] = resolution.entries.map((entry) => {
    const hit = hitMembers.get(entry.key);
    if (hit !== undefined) {
      return {
        key: entry.key,
        member: hit,
        headerEntry: {
          name: entry.key,
          detail: `${entry.source} · ${entry.lane}`,
          hash: metricCacheHash(entry.source, entry.lane),
        },
      };
    }
    const schema = describedByKey.get(entry.key) ?? emptyMetricSchema(entry);
    return {
      key: entry.key,
      member: renderMetricEntry(schema),
      headerEntry:
        schema.degraded === true
          ? undefined
          : {
              name: entry.key,
              detail: `${entry.source} · ${entry.lane}`,
              hash: metricCacheHash(entry.source, entry.lane),
            },
    };
  });

  // Result schemas (metadata for the caller). Cache hits don't reconstruct a
  // full MetricSchema — they surface a lightweight non-degraded placeholder
  // carrying the key/source/lane, which is all any caller reads.
  const schemas = resolution.entries.map((entry) => {
    const described = describedByKey.get(entry.key);
    if (described !== undefined) return described;
    if (hitMembers.has(entry.key)) {
      return {
        key: entry.key,
        source: entry.source,
        lane: entry.lane,
        measures: [],
        dimensions: [],
      } satisfies MetricSchema;
    }
    logger.warn(
      "no schema resolved for metric key %s — emitting degraded types (should not happen)",
      entry.key,
    );
    return emptyMetricSchema(entry);
  });

  // Preserve the prior file's timestamp when the entry set is unchanged → the
  // .d.ts stays byte-identical on an all-hit pass (no git churn).
  const priorMetricOut = await fs
    .readFile(metricOutFile, "utf-8")
    .catch(() => "");
  await fs.mkdir(path.dirname(metricOutFile), { recursive: true });
  await fs.writeFile(
    metricOutFile,
    generateMetricTypeDeclarationsFromMembers(members, {
      priorSource: priorMetricOut,
    }),
    "utf-8",
  );

  logger.debug(
    "Wrote MetricRegistry augmentation for %d metric(s)%s",
    schemas.length,
    failures.length > 0 ? ` (${failures.length} failure(s))` : "",
  );

  return {
    metricOutFile,
    schemas,
    failures,
    fatalErrors,
    noConfig: false,
  };
}

// Rolldown tree-shaking only preserves "own exports" (locally defined) — not re-exports.
// A local binding ensures the serving vite plugin's import keeps this in the dependency graph,
// mirroring how generateFromEntryPoint (also defined here) is preserved via the analytics vite plugin.
export const generateServingTypes = generateServingTypesImpl;

// Re-export the mv-registry types so consumers (CLI, the type-generator
// .d.ts shim in `packages/shared`) can pick them up from this entry point —
// the .d.ts shim documents these as part of the package's public surface.
export type {
  MetricColumnMetadata,
  MetricLane,
  MetricSchema,
  MetricSyncFailure,
  MetricSyncResult,
};

export const TYPES_DIR = "appkit-types";
export const ANALYTICS_TYPES_FILE = "analytics.d.ts";
export const SERVING_TYPES_FILE = "serving.d.ts";
export const METRIC_TYPES_FILE = "metric-views.d.ts";
