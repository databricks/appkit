import fs from "node:fs/promises";
import path from "node:path";
import { WorkspaceClient } from "@databricks/sdk-experimental";
import dotenv from "dotenv";
import pc from "picocolors";
import { createLogger } from "../logging/logger";
import {
  isRevivableMetricCacheEntry,
  loadCache,
  type MetricCacheEntry,
  metricCacheHash,
  saveCache,
} from "./cache";
import { getErrorDiagnostic, isConnectivityError } from "./errors";
import {
  migrateProjectConfig,
  removeOldGeneratedTypes,
  resolveProjectRoot,
} from "./migration";
import { readMetricConfig, resolveMetricConfig } from "./mv-registry/config";
import { createWorkspaceDescribeFetcher } from "./mv-registry/describe";
import { generateMetricsMetadataJson } from "./mv-registry/metadata";
import { generateMetricTypeDeclarations } from "./mv-registry/render-types";
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
 * Upper bound (~5 min) on how long the metric path's `blocking`-mode preflight
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
    // Unique message → keep the compact one-line `tag name message` form.
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
function generateTypeDeclarations(querySchemas: QuerySchema[] = []): string {
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

  return `// Auto-generated by AppKit - DO NOT EDIT
// Generated by 'npx @databricks/appkit generate-types' or Vite plugin during build
import "@databricks/appkit-ui/react";
import type { SQLTypeMarker, SQLStringMarker, SQLNumberMarker, SQLBooleanMarker, SQLBinaryMarker, SQLDateMarker, SQLTimestampMarker } from "@databricks/appkit-ui/js";

declare module "@databricks/appkit-ui/react" {
  interface QueryRegistry {${querySection}}
}
`;
}

/**
 * Status-only probe for the metric-view gate in {@link generateFromEntryPoint}:
 * what state is the warehouse in right now?
 *
 * Uses {@link getWarehouseState} (`warehouses.get`) — a read-only GET that can
 * never start the warehouse — unlike the metric DESCRIBE statements it guards,
 * whose execution auto-starts a stopped warehouse and waits on it.
 *
 * Returns the observed state so the gate can distinguish a transient
 * not-running state (STOPPED/STARTING/... → degraded entries that retry) from a
 * terminal one (DELETED/DELETING → degraded entries pinned sticky). Takes the
 * lazy client *getter* (not a client) so the probe also absorbs client
 * construction failure. A connectivity blip returns `undefined`, which the gate
 * reads as transient not-running; a deterministic failure (auth, bad id) is
 * re-thrown so the gate can classify it fatal rather than silently degrading.
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
 * @param options.mvOutFile - optional output file for the MetricRegistry
 *   augmentation. Defaults to a sibling `metric.d.ts` file under the same
 *   directory as `outFile`. Skipped entirely if `metric-views.json` is absent.
 * @param options.mvMetadataOutFile - optional output file for the
 *   build-time semantic metadata JSON bundle (`metrics.metadata.json`).
 *   Defaults to a sibling of `mvOutFile`. Skipped entirely if
 *   `metric-views.json` is absent.
 * @param options.metricFetcher - optional DescribeFetcher used by
 *   {@link syncMetrics} (tests inject a mock; production lazily builds a
 *   default WorkspaceClient-backed one). An injected fetcher always runs: it
 *   hits no warehouse, so it bypasses both the non-blocking gate and the
 *   blocking preflight.
 */
export async function generateFromEntryPoint(options: {
  outFile: string;
  queryFolder?: string;
  warehouseId: string;
  noCache?: boolean;
  mode?: PreflightMode;
  mvOutFile?: string;
  mvMetadataOutFile?: string;
  metricFetcher?: DescribeFetcher;
}) {
  const {
    outFile,
    queryFolder,
    warehouseId,
    noCache,
    mode = "non-blocking",
    mvOutFile,
    mvMetadataOutFile,
    metricFetcher,
  } = options;
  const projectRoot = resolveProjectRoot(outFile);

  logger.debug("Starting type generation...");

  let queryRegistry: QuerySchema[] = [];
  let syntaxErrors: QuerySyntaxError[] = [];
  let fatalErrors: QueryFatalError[] = [];
  if (queryFolder) {
    const result = await generateQueriesFromDescribe(queryFolder, warehouseId, {
      noCache,
      mode,
    });
    queryRegistry = result.schemas;
    syntaxErrors = result.syntaxErrors ?? [];
    fatalErrors = result.fatalErrors ?? [];
  }

  const typeDeclarations = generateTypeDeclarations(queryRegistry);

  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, typeDeclarations, "utf-8");

  // Metric-view types: only emit when metric-views.json exists. The path is
  // purely additive — apps that never adopt metric views must not produce
  // empty noise.
  if (queryFolder) {
    const mvConfig = await readMetricConfig(queryFolder);
    if (mvConfig) {
      const resolution = resolveMetricConfig(mvConfig);

      // Metric schemas persist in the shared typegen cache as a `metrics`
      // section (sibling of `queries`, same file/version), keyed by metric key
      // with md5("<source>|<lane>") as the change detector. Loaded strictly
      // AFTER the query path's own load → mutate → save cycle, so the single
      // metric-side save below can never clobber a query entry.
      const cache = await loadCache();

      // The section is consumed through a null-prototype copy: metric keys
      // are user-controlled config input and "__proto__" passes the metric
      // key regex — on a plain object, writing it would hit the
      // Object.prototype setter (mutating the object's prototype and silently
      // dropping the entry) instead of storing data. A null prototype also
      // keeps partition reads from resolving inherited names ("constructor",
      // "toString", ...) as phantom entries.
      const mvCacheSection: Record<string, MetricCacheEntry> =
        Object.create(null);
      if (!noCache && cache.metrics) {
        for (const key of Object.keys(cache.metrics)) {
          mvCacheSection[key] = cache.metrics[key];
        }
      }

      // Partition BEFORE any gate/preflight decision: a hit (structurally valid
      // entry, hash match, not retry-flagged) is served from cache no matter
      // what the warehouse is doing — a degraded pass falls back to
      // last-known-good schemas, exactly like queries degrade to cached types.
      // Only the remainder (new, edited, retry-flagged, or unrevivable entries)
      // is eligible for DESCRIBE, so a fully-warm pass makes zero warehouse
      // calls and constructs zero clients.
      const hitSchemas = new Map<string, MetricSchema>();
      const describeNeeded: typeof resolution.entries = [];
      // Degraded cached schemas pinned `retry: false` are sticky failures: they
      // serve their permissive schema like any hit, but are collected here for
      // the single notice below so the misconfiguration isn't silently hidden.
      const stickyDegradedHits: string[] = [];
      for (const entry of resolution.entries) {
        const prior = mvCacheSection[entry.key];
        if (
          prior !== undefined &&
          isRevivableMetricCacheEntry(prior) &&
          prior.hash === metricCacheHash(entry.source, entry.lane) &&
          !prior.retry
        ) {
          hitSchemas.set(entry.key, prior.schema);
          if (prior.schema.degraded === true) {
            stickyDegradedHits.push(entry.key);
          }
        } else {
          describeNeeded.push(entry);
        }
      }

      if (stickyDegradedHits.length > 0) {
        logger.warn(
          "cached failure for %s — fix the entry in metric-views.json or run with --no-cache to retry.",
          stickyDegradedHits.join(", "),
        );
      }

      // At most ONE WorkspaceClient per pass for the whole metric path: the
      // status probe, the blocking preflight, and the default DESCRIBE fetcher
      // share this lazily-created instance, so a pass that never contacts the
      // warehouse constructs zero clients.
      let mvClient: WorkspaceClient | undefined;
      const getMvClient = (): WorkspaceClient => {
        mvClient ??= new WorkspaceClient({});
        return mvClient;
      };

      // Blocking-mode preflight: ensure the warehouse is running before the
      // DESCRIBE batch (probe → decide → wait / start+wait; only
      // DELETED/DELETING is fatal). Deliberately split from the query path's
      // preflight — metric views may bind a different warehouse in future. Two
      // softenings vs the query preflight: a failed probe and a timed-out wait
      // are NOT fatal here — we fall through to syncMetrics, which classifies a
      // still-not-ready warehouse as degraded rather than failing the build.
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
            // treatStoppedAsTransient rides out the stale pre-start
            // STOPPED/STOPPING reading, same as the query preflight.
            await startWarehouse(getMvClient(), warehouseId);
            const settled = await waitUntilRunning(getMvClient(), warehouseId, {
              maxMs: MV_PREFLIGHT_WAIT_MAX_MS,
              treatStoppedAsTransient: true,
            });
            if (settled !== "RUNNING") {
              // With treatStoppedAsTransient, a non-RUNNING resolve is
              // exactly DELETED/DELETING — the warehouse was deleted while
              // we waited. Fatal, same as catching it at decision time.
              preflightFatalMessage = `warehouse ${warehouseId} is ${settled}`;
            }
          } else if (decision === "waitThenProceed") {
            const settled = await waitUntilRunning(getMvClient(), warehouseId, {
              maxMs: MV_PREFLIGHT_WAIT_MAX_MS,
            });
            if (settled === "DELETED" || settled === "DELETING") {
              // Deleted mid-wait: fatal. A STOPPED/STOPPING resolve (this
              // wait runs without treatStoppedAsTransient) stays a soft
              // fall-through — a stopped warehouse is startable, so it
              // degrades and converges rather than failing the build.
              preflightFatalMessage = `warehouse ${warehouseId} is ${settled}`;
            }
          }
        } catch (err) {
          // Connectivity blip: fall through to syncMetrics, whose DESCRIBEs
          // degrade a not-ready / unreachable warehouse rather than throwing. A
          // deterministic failure (auth, bad warehouse id, a timed-out start)
          // is fatal — surface it instead of stalling ~5 min against a
          // not-ready warehouse, mirroring the query path's preflight catch.
          if (!isConnectivityError(err)) {
            preflightFatalMessage = `warehouse ${warehouseId}: ${getErrorDiagnostic(err)}`;
          }
        }
      }

      // Honor the non-blocking preflight contract (#406) for metric DESCRIBEs:
      // a `DESCRIBE TABLE EXTENDED ... AS JSON` waits up to 30s per key and
      // auto-starts a stopped warehouse — exactly what "non-blocking" promises
      // not to do. So one status-only probe (which can't start the warehouse)
      // decides whether to DESCRIBE now or emit degraded artifacts for a later
      // blocking run; it keeps the observed state so the skip can tell a
      // transient not-running warehouse from a terminal DELETED/DELETING one.
      let gateState: WarehouseState | undefined;
      let describeNow =
        metricFetcher !== undefined ||
        mode !== "non-blocking" ||
        describeNeeded.length === 0;
      if (!describeNow) {
        try {
          gateState = await probeWarehouseState(getMvClient, warehouseId);
        } catch (err) {
          // probeWarehouseState only throws on a deterministic failure (auth,
          // bad warehouse id) — a connectivity blip already returned undefined.
          // Pin it fatal through the same path as a fatal blocking preflight.
          preflightFatalMessage = `warehouse ${warehouseId}: ${getErrorDiagnostic(err)}`;
        }
        describeNow = gateState === "RUNNING";
      }

      let described: MetricSchema[];
      let failures: MetricSyncFailure[] = [];
      // True when this pass skipped DESCRIBE for a reason that can never
      // self-converge — a deleted/deleting warehouse (fatal preflight or gate
      // skip). The write site pins those degraded outcomes sticky.
      let terminalSkip = false;
      if (preflightFatalMessage !== undefined) {
        // Fatal preflight (deleted/deleting warehouse): fail like the query
        // path — skip DESCRIBE, emit degraded schemas so both artifacts are
        // still written, and record one fatal error per describe-needed key
        // (cache hits are unaffected). The end-of-run throw below surfaces them
        // after the writes. Terminal, so these entries are pinned sticky.
        described = describeNeeded.map(emptyMetricSchema);
        terminalSkip = true;
        for (const entry of describeNeeded) {
          fatalErrors.push({ name: entry.key, message: preflightFatalMessage });
        }
      } else if (describeNeeded.length === 0) {
        // Nothing left to describe — every configured key was a cache hit.
        // syncMetrics would be a no-op (and building its fetcher would
        // construct a client for nothing); artifacts regenerate from cache.
        described = [];
      } else if (describeNow) {
        const fetcher =
          metricFetcher ??
          createWorkspaceDescribeFetcher(getMvClient(), warehouseId);
        ({ schemas: described, failures } = await syncMetrics(
          { entries: describeNeeded },
          fetcher,
        ));

        // Surface DESCRIBE failures loudly: a misconfigured metric-views.json
        // would otherwise silently ship an empty entry that the runtime
        // fail-closed gate 503s in production. syncMetrics is log-free; this
        // caller is the single owner of failure logging.
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

        // Degraded-but-not-failed keys: the warehouse answered with a
        // non-terminal state (stopped / cold-starting), so their schemas are
        // unknown — not errors. One summary line, no per-key warns; failed
        // keys are excluded (the warn loop above already reported them).
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
        // describe-needed key as a degraded schema (permissive types) so both
        // artifacts exist; cache hits keep serving last-known-good. A transient
        // state refreshes on a later RUNNING pass; a DELETED/DELETING probe is
        // terminal, so those keys are pinned sticky below.
        described = describeNeeded.map(emptyMetricSchema);
        terminalSkip = gateState === "DELETED" || gateState === "DELETING";
        logger.info(
          "Warehouse %s is not running — wrote degraded metric types (permissive) for %d metric view(s) (%s); they will refresh once the warehouse is available.",
          warehouseId,
          describeNeeded.length,
          describeNeeded.map((e) => e.key).join(", "),
        );
      }

      // Persist outcomes for exactly the keys this pass owned (the
      // describe-needed set); hits were partitioned out above and are never
      // rewritten, so a warehouse-down pass keeps last-known-good entries. A
      // successful DESCRIBE caches `retry: false`; a degraded outcome caches
      // `retry: true` only when re-describing could later succeed (non-terminal
      // state or transient failure), else sticky `retry: false`. One save per
      // pass; with `noCache` the section started empty, so it's overwritten.
      const failureByKey = new Map<string, MetricSyncFailure>();
      for (const failure of failures) {
        failureByKey.set(failure.key, failure);
      }
      for (let i = 0; i < describeNeeded.length; i++) {
        // syncMetrics (and both .map(emptyMetricSchema) branches) return
        // one schema per entry in entry order, so described[i] always
        // belongs to describeNeeded[i].
        const entry = describeNeeded[i];
        const failure = failureByKey.get(entry.key);
        mvCacheSection[entry.key] = {
          hash: metricCacheHash(entry.source, entry.lane),
          schema: described[i],
          retry:
            described[i].degraded === true &&
            !terminalSkip &&
            (failure === undefined || failure.transient === true),
        };
      }

      // Prune entries whose key is no longer configured, so a removed metric
      // doesn't haunt the cache file forever.
      const configuredKeys = new Set(resolution.entries.map((e) => e.key));
      let prunedCount = 0;
      for (const key of Object.keys(mvCacheSection)) {
        if (!configuredKeys.has(key)) {
          delete mvCacheSection[key];
          prunedCount++;
        }
      }

      // Save when this pass produced outcomes, bypassed the cache, or pruned
      // — a warm pass over a shrunk config has nothing to describe but must
      // still shrink the file.
      if (describeNeeded.length > 0 || noCache || prunedCount > 0) {
        cache.metrics = mvCacheSection;
        await saveCache(cache);
      }

      // Merge cached hits with fresh results back into config order
      // (resolution.entries order — the renderers sort internally where
      // determinism matters).
      const describedByKey = new Map<string, MetricSchema>();
      for (const schema of described) {
        describedByKey.set(schema.key, schema);
      }
      const mvSchemas = resolution.entries.map((entry) => {
        const schema =
          hitSchemas.get(entry.key) ?? describedByKey.get(entry.key);
        if (schema !== undefined) return schema;
        // Defensive: every entry is either a cache hit or describe-needed (and
        // every describe-needed entry yields exactly one schema above), so this
        // should be unreachable. If the invariant ever breaks, warn loudly but
        // still emit a permissive degraded schema — the metric path never
        // crashes a build over a single entry.
        logger.warn(
          "no schema resolved for metric key %s — emitting degraded types (should not happen)",
          entry.key,
        );
        return emptyMetricSchema(entry);
      });

      const mvFile =
        mvOutFile ?? path.join(path.dirname(outFile), METRIC_TYPES_FILE);
      const mvDeclarations = generateMetricTypeDeclarations(mvSchemas);
      await fs.mkdir(path.dirname(mvFile), { recursive: true });
      await fs.writeFile(mvFile, mvDeclarations, "utf-8");

      // Emit the semantic-metadata JSON bundle alongside the .d.ts. The hook
      // imports this artifact (via a registration call from the consuming
      // app) and exposes the per-metric subset on its return value.
      const mvMetadataFile =
        mvMetadataOutFile ??
        path.join(path.dirname(mvFile), METRIC_METADATA_FILE);
      const metadataJson = generateMetricsMetadataJson(mvSchemas);
      await fs.mkdir(path.dirname(mvMetadataFile), { recursive: true });
      await fs.writeFile(mvMetadataFile, metadataJson, "utf-8");

      logger.debug(
        "Wrote MetricRegistry augmentation + metadata bundle for %d metric(s)%s",
        mvSchemas.length,
        failures.length > 0 ? ` (${failures.length} failure(s))` : "",
      );
    }
  }

  // One-time migration: remove old generated file and patch project configs
  await removeOldGeneratedTypes(projectRoot, "appKitTypes.d.ts");
  await migrateProjectConfig(projectRoot);

  // Types are always written above — including `result: unknown` for any query
  // that could not be described. Connectivity failures pass silently so a
  // transient warehouse outage never blocks a build; genuine SQL errors and
  // non-connectivity fatal request failures surface after the file write.
  if (syntaxErrors.length > 0) {
    throw new TypegenSyntaxError(syntaxErrors, warehouseId, fatalErrors);
  }
  if (fatalErrors.length > 0) {
    throw new TypegenFatalError(fatalErrors, warehouseId);
  }

  logger.debug("Type generation complete!");
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

/** Directory name for generated AppKit type declaration files. */
export const TYPES_DIR = "appkit-types";
/** Default filename for analytics query type declarations. */
export const ANALYTICS_TYPES_FILE = "analytics.d.ts";
/** Default filename for serving endpoint type declarations. */
export const SERVING_TYPES_FILE = "serving.d.ts";
/** Default filename for metric-view registry type declarations. */
export const METRIC_TYPES_FILE = "metric.d.ts";
/**
 * Default filename for the build-time semantic-metadata JSON bundle, sibling of
 * {@link METRIC_TYPES_FILE}. Shape is `Record<metricKey, { measures,
 * dimensions }>` (UC FQN and execution lane are server-side concerns, kept out
 * of this client-shipped artifact). The consuming app imports it at build time
 * and registers it via `@databricks/appkit-ui/format`'s
 * `registerMetricsMetadata()`, so the React hook returns per-metric `metadata`
 * without a second network round-trip.
 */
export const METRIC_METADATA_FILE = "metrics.metadata.json";
