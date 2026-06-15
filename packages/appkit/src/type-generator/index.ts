import fs from "node:fs/promises";
import path from "node:path";
import { WorkspaceClient } from "@databricks/sdk-experimental";
import dotenv from "dotenv";
import pc from "picocolors";
import { createLogger } from "../logging/logger";
import { hashSQL, loadCache, type MetricCacheEntry, saveCache } from "./cache";
import {
  createWorkspaceDescribeFetcher,
  type DescribeFetcher,
  emptyMetricSchema,
  generateMetricsMetadataJson,
  generateMetricTypeDeclarations,
  type MetricColumnMetadata,
  type MetricLane,
  type MetricSchema,
  type MetricSyncFailure,
  type MetricSyncResult,
  readMetricConfig,
  resolveMetricConfig,
  syncMetrics,
} from "./metric-registry";
import {
  migrateProjectConfig,
  removeOldGeneratedTypes,
  resolveProjectRoot,
} from "./migration";
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
 * Upper bound on how long the metric path's `blocking`-mode preflight waits
 * for a warehouse to reach RUNNING (~5 min). Mirrors the query path's
 * (unexported) `PREFLIGHT_WAIT_MAX_MS` in query-registry.ts; kept as a
 * separate metric-local constant because the two preflights are deliberately
 * split — queries and metric views may bind to different warehouses in the
 * future.
 */
const METRIC_PREFLIGHT_WAIT_MAX_MS = 300_000;

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
 * whose statement execution auto-starts a stopped warehouse and waits on it.
 *
 * Returns the observed state so the gate can distinguish a transient
 * not-running state (STOPPED/STARTING/... → degraded entries that retry) from
 * a terminal one (DELETED/DELETING → degraded entries pinned sticky: they can
 * never self-converge).
 *
 * Takes the metric path's lazy client *getter* (not a constructed client) so
 * the probe's failure semantics cover client construction too: any failure to
 * observe a state — connectivity, auth, bad id, or SDK construction — returns
 * `undefined`, which the gate reads as a transient not-running state. In
 * non-blocking mode typegen must never block on, or fail because of, the
 * warehouse, so the caller degrades and a later blocking run (e.g. the Vite
 * plugin's warehouse watch) lands the real schemas.
 */
async function probeWarehouseState(
  getClient: () => WorkspaceClient,
  warehouseId: string,
): Promise<WarehouseState | undefined> {
  try {
    return await getWarehouseState(getClient(), warehouseId);
  } catch {
    return undefined;
  }
}

/**
 * Structural gate for reviving a cached metric entry at partition time.
 *
 * The cache file lives in `node_modules/.databricks` and is plain JSON —
 * hand-edits, truncation, or a stale writer can leave entries whose shape no
 * longer matches {@link MetricCacheEntry}. A malformed entry must read as a
 * cache MISS (re-describe) rather than crash the pass or render revived
 * garbage into the artifacts. Checks exactly what the renderers and the
 * metadata bundle consume: `hash` string, `retry` boolean, and a schema with
 * `key`/`source` strings, a valid lane, an optional boolean `degraded`, and
 * measure/dimension arrays whose elements carry `name`/`type` strings
 * (other column fields are optional). Deliberately inline — the shared Zod
 * schemas must not enter the type-generator's runtime path.
 */
function isRevivableMetricCacheEntry(entry: MetricCacheEntry): boolean {
  if (typeof entry.hash !== "string" || typeof entry.retry !== "boolean") {
    return false;
  }
  const schema = entry.schema as unknown;
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return false;
  }
  const s = schema as Record<string, unknown>;
  const isColumnArray = (value: unknown): boolean =>
    Array.isArray(value) &&
    value.every(
      (col) =>
        typeof col === "object" &&
        col !== null &&
        typeof (col as Record<string, unknown>).name === "string" &&
        typeof (col as Record<string, unknown>).type === "string",
    );
  return (
    typeof s.key === "string" &&
    typeof s.source === "string" &&
    (s.lane === "sp" || s.lane === "obo") &&
    (s.degraded === undefined || typeof s.degraded === "boolean") &&
    isColumnArray(s.measures) &&
    isColumnArray(s.dimensions)
  );
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
 * @param options.mode - preflight policy (see {@link PreflightMode}). For
 *   queries, `"non-blocking"` never probes or describes the warehouse. For
 *   metric views, `"non-blocking"` makes one status-only probe and DESCRIBEs
 *   only when the warehouse is already RUNNING; otherwise permissive degraded
 *   metric types are emitted immediately and the affected keys are cached
 *   with `retry: true`, converging to real schemas on the next
 *   describe-capable pass — in dev the Vite plugin's warehouse watch triggers
 *   that pass automatically, while one-shot CLI runs (e.g. postinstall) leave
 *   no background waiter and converge on their next run. (A probe that reads
 *   DELETED/DELETING instead caches the keys sticky — `retry: false` — since
 *   they can never converge; the sticky-hit notice surfaces them on later
 *   passes.) `"blocking"` first ensures the warehouse is running — it waits
 *   for a starting warehouse and starts (then waits for) a stopped one,
 *   failing the build only for a deleted/deleting warehouse (observed at the
 *   first check or mid-wait), exactly like the query path's fatal
 *   preflight — and then DESCRIBEs. Defaults to `"non-blocking"`.
 * @param options.metricOutFile - optional output file for the MetricRegistry
 *   augmentation. Defaults to a sibling `metric.d.ts` file under the same
 *   directory as `outFile`. Skipped entirely if `metric-views.json` is absent.
 * @param options.metricMetadataOutFile - optional output file for the
 *   build-time semantic metadata JSON bundle (`metrics.metadata.json`).
 *   Defaults to a sibling of `metricOutFile`. Skipped entirely if
 *   `metric-views.json` is absent.
 * @param options.metricFetcher - optional DescribeFetcher used by
 *   {@link syncMetrics}. Tests inject a mock; production builds let the
 *   default WorkspaceClient-backed fetcher be created lazily. An injected
 *   fetcher always runs — it bypasses the non-blocking warehouse gate AND the
 *   blocking-mode preflight, since it does not hit a warehouse: skipping it
 *   would only blind the tests and CI runs that inject it, and preflighting
 *   for it would construct an SDK client nothing needs.
 */
export async function generateFromEntryPoint(options: {
  outFile: string;
  queryFolder?: string;
  warehouseId: string;
  noCache?: boolean;
  mode?: PreflightMode;
  metricOutFile?: string;
  metricMetadataOutFile?: string;
  metricFetcher?: DescribeFetcher;
}) {
  const {
    outFile,
    queryFolder,
    warehouseId,
    noCache,
    mode = "non-blocking",
    metricOutFile,
    metricMetadataOutFile,
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
    const metricConfig = await readMetricConfig(queryFolder);
    if (metricConfig) {
      const resolution = resolveMetricConfig(metricConfig);

      // Metric schemas persist in the shared typegen cache as a `metrics`
      // section (sibling of `queries`, same file, same version) keyed by
      // metric key with md5("<source>|<lane>") as the change detector. The
      // cache is (re)loaded here — strictly AFTER generateQueriesFromDescribe
      // above has finished its own load → mutate → save cycle — so the single
      // metric-side save below re-serializes the exact `queries` object it
      // just read and can never clobber a query entry.
      const cache = await loadCache();

      // The section is consumed through a null-prototype copy: metric keys
      // are user-controlled config input and "__proto__" passes the metric
      // key regex — on a plain object, writing it would hit the
      // Object.prototype setter (mutating the object's prototype and silently
      // dropping the entry) instead of storing data. A null prototype also
      // keeps partition reads from resolving inherited names ("constructor",
      // "toString", ...) as phantom entries.
      const metricsSection: Record<string, MetricCacheEntry> =
        Object.create(null);
      if (!noCache && cache.metrics) {
        for (const key of Object.keys(cache.metrics)) {
          metricsSection[key] = cache.metrics[key];
        }
      }

      // Partition BEFORE any gate/preflight decision: a hit (structurally
      // valid entry, hash match, and not flagged for retry) is served from
      // cache no matter what the warehouse is doing — a degraded-mode pass
      // falls back to last-known-good schemas exactly like queries degrade
      // to cached types. Only the remainder — new keys, edited entries,
      // retry-flagged degraded entries, and malformed (unrevivable) entries
      // — is eligible for DESCRIBE, so a fully-warm pass makes zero
      // warehouse calls and constructs zero clients. `noCache` left the
      // section empty above, which makes every configured key
      // describe-needed here.
      const hitSchemas = new Map<string, MetricSchema>();
      const describeNeeded: typeof resolution.entries = [];
      // Parallel to describeNeeded: the config hash to persist per key.
      const neededHashes: string[] = [];
      // Hits whose cached schema is degraded are STICKY failures: a previous
      // pass pinned them with `retry: false` because re-describing the
      // unchanged entry can't succeed (deterministic DESCRIBE failure, or a
      // deleted warehouse). They serve their permissive schemas like any hit,
      // but silently doing so forever would hide the misconfiguration —
      // collect them for the single notice below.
      const stickyDegradedHits: string[] = [];
      for (const entry of resolution.entries) {
        const hash = hashSQL(`${entry.source}|${entry.lane}`);
        const prior = metricsSection[entry.key];
        if (
          prior !== undefined &&
          isRevivableMetricCacheEntry(prior) &&
          prior.hash === hash &&
          !prior.retry
        ) {
          hitSchemas.set(entry.key, prior.schema);
          if (prior.schema.degraded === true) {
            stickyDegradedHits.push(entry.key);
          }
        } else {
          describeNeeded.push(entry);
          neededHashes.push(hash);
        }
      }

      if (stickyDegradedHits.length > 0) {
        logger.warn(
          "cached failure for %s — fix the entry in metric-views.json or run with --no-cache to retry.",
          stickyDegradedHits.join(", "),
        );
      }

      // At most ONE WorkspaceClient per generation pass for the whole metric
      // path: the non-blocking status probe, the blocking preflight, and the
      // default DESCRIBE fetcher all share this lazily-created instance. A
      // pass that never contacts the warehouse constructs zero clients: an
      // injected metricFetcher covers fetching (and skips probe/preflight),
      // and a pass with nothing describe-needed — fully-warm cache or an
      // empty metricViews map — has nothing to describe in any mode.
      let metricClient: WorkspaceClient | undefined;
      const getMetricClient = (): WorkspaceClient => {
        metricClient ??= new WorkspaceClient({});
        return metricClient;
      };

      // Blocking-mode preflight: ensure the warehouse is running before the
      // DESCRIBE batch, mirroring the query path's flow (probe → decide →
      // wait / start+wait; only DELETED/DELETING is fatal — at decision time
      // OR observed mid-wait). Deliberately SPLIT from the query path's
      // preflight rather than shared — queries and metric views may bind to
      // different warehouses in the future. Two deliberate softenings versus
      // the query preflight: a failed probe and a timed-out wait (thrown)
      // are NOT fatal here. We fall through to syncMetrics, whose DESCRIBEs
      // classify a still-not-ready warehouse as degraded (permissive types,
      // refreshed by a later run) rather than failing the build. An injected
      // metricFetcher needs no warehouse, so it skips the preflight entirely.
      let preflightFatalMessage: string | undefined;
      if (
        mode === "blocking" &&
        metricFetcher === undefined &&
        describeNeeded.length > 0
      ) {
        try {
          const state = await getWarehouseState(getMetricClient(), warehouseId);
          const decision = decidePreflight(state, mode);
          if (decision === "fatal") {
            preflightFatalMessage = `warehouse ${warehouseId} is ${state}`;
          } else if (decision === "startWaitProceed") {
            // Stopped/stopping: nudge it awake, then poll to RUNNING.
            // treatStoppedAsTransient rides out the stale pre-start
            // STOPPED/STOPPING reading, same as the query preflight.
            await startWarehouse(getMetricClient(), warehouseId);
            const settled = await waitUntilRunning(
              getMetricClient(),
              warehouseId,
              {
                maxMs: METRIC_PREFLIGHT_WAIT_MAX_MS,
                treatStoppedAsTransient: true,
              },
            );
            if (settled !== "RUNNING") {
              // With treatStoppedAsTransient, a non-RUNNING resolve is
              // exactly DELETED/DELETING — the warehouse was deleted while
              // we waited. Fatal, same as catching it at decision time.
              preflightFatalMessage = `warehouse ${warehouseId} is ${settled}`;
            }
          } else if (decision === "waitThenProceed") {
            const settled = await waitUntilRunning(
              getMetricClient(),
              warehouseId,
              {
                maxMs: METRIC_PREFLIGHT_WAIT_MAX_MS,
              },
            );
            if (settled === "DELETED" || settled === "DELETING") {
              // Deleted mid-wait: fatal. A STOPPED/STOPPING resolve (this
              // wait runs without treatStoppedAsTransient) stays a soft
              // fall-through — a stopped warehouse is startable, so it
              // degrades and converges rather than failing the build.
              preflightFatalMessage = `warehouse ${warehouseId} is ${settled}`;
            }
          }
          // "proceed" — and a wait that resolved into a startable state —
          // falls through to syncMetrics below.
        } catch {
          // Probe/start failure or a wait that timed out: fall through to
          // syncMetrics. DESCRIBEs against a not-ready warehouse come back
          // non-terminal and classify as degraded — never thrown — so the
          // build still writes both artifacts.
        }
      }

      // Honor the non-blocking preflight contract (#406) for metric DESCRIBEs
      // too: each `DESCRIBE TABLE EXTENDED ... AS JSON` waits up to 30s per
      // key and auto-starts a stopped warehouse — exactly what "non-blocking"
      // promises never to do. One status-only probe (a GET that can never
      // start the warehouse) decides whether to describe now or emit degraded
      // artifacts that a later blocking run refreshes. The probe keeps the
      // observed state (not just a boolean) so the skip below can tell a
      // transient not-running state from a terminal DELETED/DELETING one. An
      // injected metricFetcher always runs: it doesn't hit a warehouse
      // (tests/CI inject mocks), so gating it would only skip meaningful
      // work. A pass with nothing describe-needed — fully-warm cache or an
      // empty metricViews map — needs no probe either: nothing would be
      // described in any mode.
      let gateState: WarehouseState | undefined;
      let describeNow =
        metricFetcher !== undefined ||
        mode !== "non-blocking" ||
        describeNeeded.length === 0;
      if (!describeNow) {
        gateState = await probeWarehouseState(getMetricClient, warehouseId);
        describeNow = gateState === "RUNNING";
      }

      let described: MetricSchema[];
      let failures: MetricSyncFailure[] = [];
      // True when this pass skipped the DESCRIBE batch for a reason that can
      // never self-converge — a deleted/deleting warehouse (fatal preflight
      // or gate skip). The write site pins those degraded outcomes sticky
      // (`retry: false`) instead of re-describing them forever.
      let terminalSkip = false;
      if (preflightFatalMessage !== undefined) {
        // Fatal preflight (deleted/deleting warehouse — at decision time or
        // mid-wait): fail exactly like the query path's fatal preflight —
        // skip the DESCRIBE batch, emit degraded schemas so both artifacts
        // are still written, and record one fatal error per describe-needed
        // key (cache hits are unaffected: they serve their cached schemas).
        // The shared end-of-run throw below (TypegenFatalError, or
        // TypegenSyntaxError's fatalQueries when syntax errors coexist)
        // surfaces them after the writes, identically to query fatals. The
        // skip is terminal — these keys can never converge against a deleted
        // warehouse — so their cache entries are pinned sticky.
        described = describeNeeded.map(emptyMetricSchema);
        terminalSkip = true;
        for (const entry of describeNeeded) {
          fatalErrors.push({ name: entry.key, message: preflightFatalMessage });
        }
      } else if (describeNeeded.length === 0) {
        // Nothing left to describe — every configured key (if any) was a
        // cache hit. syncMetrics would be a no-op, and building its default
        // fetcher would construct a client for nothing. The artifacts below
        // regenerate from cached schemas alone.
        described = [];
      } else if (describeNow) {
        const fetcher =
          metricFetcher ??
          createWorkspaceDescribeFetcher(getMetricClient(), warehouseId);
        ({ schemas: described, failures } = await syncMetrics(
          { entries: describeNeeded },
          fetcher,
        ));

        // Surface DESCRIBE failures loudly so a misconfigured metric-views.json
        // or a workspace-side typo doesn't silently ship an empty bundle entry.
        // The route's runtime fail-closed gate would 503 these in production —
        // catching the issue at type-gen time is the cheaper signal.
        // syncMetrics itself is log-free; this caller is the single owner of
        // failure logging.
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
        // Deliberately un-probed DESCRIBEs, not failures: emit every
        // describe-needed key as a degraded schema (permissive types, empty
        // runtime allowlists) so both artifacts always exist, and say so
        // once — no per-key warnings (nothing failed). Cache hits keep
        // serving their last-known-good schemas — only the remainder
        // degrades. For a transient state (stopped/starting/probe failure)
        // the dev warehouse watch (or the next blocking run) re-enters this
        // path with the warehouse RUNNING and lands the real schemas. A
        // DELETED/DELETING probe is terminal: those keys are pinned sticky
        // below (non-blocking never fails the build, so the sticky-hit
        // notice on later passes is the loud signal).
        described = describeNeeded.map(emptyMetricSchema);
        terminalSkip = gateState === "DELETED" || gateState === "DELETING";
        logger.info(
          "Warehouse %s is not running — wrote degraded metric types (permissive) for %d metric view(s) (%s); they will refresh once the warehouse is available.",
          warehouseId,
          describeNeeded.length,
          describeNeeded.map((e) => e.key).join(", "),
        );
      }

      // Persist this pass's outcomes for exactly the keys it owned (the
      // describe-needed set): a successful DESCRIBE caches `retry: false`;
      // degraded outcomes split by whether re-describing the unchanged entry
      // can ever succeed. Self-converging degradation — non-terminal states,
      // transient fetch failures, and the gate-skip / preflight paths for a
      // merely not-running warehouse — caches `retry: true` so the next
      // eligible pass re-describes only these keys. Deterministic failures
      // (FAILED statement, zero rows, unparseable response, zero columns)
      // and terminal skips (deleted/deleting warehouse) are pinned STICKY:
      // `retry: false` with the degraded schema cached, so they hit on later
      // passes (surfacing through the sticky-hit notice) instead of
      // re-failing every describe-capable run. Hits were partitioned out
      // above and are never rewritten, which is what lets a warehouse-down
      // pass keep last-known-good entries intact. Keys dropped from the
      // config are pruned so the section tracks metric-views.json exactly.
      // One save per pass; with `noCache` the section was started empty, so
      // saving overwrites it with this pass's results alone.
      const failureByKey = new Map<string, MetricSyncFailure>();
      for (const failure of failures) {
        failureByKey.set(failure.key, failure);
      }
      for (let i = 0; i < describeNeeded.length; i++) {
        // syncMetrics (and both .map(emptyMetricSchema) branches) return
        // one schema per entry in entry order, so described[i] always
        // belongs to describeNeeded[i] / neededHashes[i].
        const failure = failureByKey.get(describeNeeded[i].key);
        metricsSection[describeNeeded[i].key] = {
          hash: neededHashes[i],
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
      for (const key of Object.keys(metricsSection)) {
        if (!configuredKeys.has(key)) {
          delete metricsSection[key];
          prunedCount++;
        }
      }

      // Save when this pass produced outcomes, bypassed the cache, or pruned
      // — a warm pass over a shrunk config has nothing to describe but must
      // still shrink the file.
      if (describeNeeded.length > 0 || noCache || prunedCount > 0) {
        cache.metrics = metricsSection;
        await saveCache(cache);
      }

      // Merge cached hits with fresh results back into config order
      // (resolution.entries order — the renderers sort internally where
      // determinism matters).
      const describedByKey = new Map<string, MetricSchema>();
      for (const schema of described) {
        describedByKey.set(schema.key, schema);
      }
      const metricSchemas = resolution.entries.map(
        (entry) =>
          hitSchemas.get(entry.key) ??
          describedByKey.get(entry.key) ??
          // Unreachable: every entry is either a hit or describe-needed, and
          // every describe-needed entry yields exactly one schema above.
          emptyMetricSchema(entry),
      );

      const metricFile =
        metricOutFile ?? path.join(path.dirname(outFile), METRIC_TYPES_FILE);
      const metricDeclarations = generateMetricTypeDeclarations(metricSchemas);
      await fs.mkdir(path.dirname(metricFile), { recursive: true });
      await fs.writeFile(metricFile, metricDeclarations, "utf-8");

      // Emit the semantic-metadata JSON bundle alongside the .d.ts. The hook
      // imports this artifact (via a registration call from the consuming
      // app) and exposes the per-metric subset on its return value.
      const metadataFile =
        metricMetadataOutFile ??
        path.join(path.dirname(metricFile), METRIC_METADATA_FILE);
      const metadataJson = generateMetricsMetadataJson(metricSchemas);
      await fs.mkdir(path.dirname(metadataFile), { recursive: true });
      await fs.writeFile(metadataFile, metadataJson, "utf-8");

      logger.debug(
        "Wrote MetricRegistry augmentation + metadata bundle for %d metric(s)%s",
        metricSchemas.length,
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

// Re-export the metric-registry types so consumers (CLI, the type-generator
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
 * Default filename for the build-time semantic-metadata JSON bundle.
 *
 * Sibling of {@link METRIC_TYPES_FILE}. The JSON shape is
 * `Record<metricKey, { measures, dimensions }>` — see `MetricsMetadataBundle`
 * in `metric-registry.ts` (UC FQN and execution lane are server-side concerns
 * and deliberately not part of this client-shipped artifact). The consuming
 * app imports this file at build time (via Vite's JSON loader / Webpack's
 * `import` etc.) and registers it through `@databricks/appkit-ui/format`'s
 * `registerMetricsMetadata()` so the React hook can return per-metric
 * `metadata` without a second network round-trip.
 */
export const METRIC_METADATA_FILE = "metrics.metadata.json";
