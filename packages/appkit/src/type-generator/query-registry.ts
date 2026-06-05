import fs from "node:fs/promises";
import path from "node:path";
import { WorkspaceClient } from "@databricks/sdk-experimental";
import pc from "picocolors";
import { createLogger } from "../logging/logger";
import { CACHE_VERSION, hashSQL, loadCache, saveCache } from "./cache";
import { decidePreflight, type PreflightMode } from "./preflight";
import { Spinner } from "./spinner";
import {
  type DatabricksStatementExecutionResponse,
  type QueryFatalError,
  type QueryGenerationResult,
  type QuerySchema,
  type QuerySyntaxError,
  sqlTypeToHelper,
  sqlTypeToMarker,
} from "./types";
import {
  getWarehouseState,
  startWarehouse,
  WAREHOUSE_WAIT_TIMEOUT,
  type WarehouseState,
  waitUntilRunning,
} from "./warehouse-status";

const logger = createLogger("type-generator:query-registry");

/**
 * Upper bound on how long a `blocking`-mode preflight will wait for a starting
 * warehouse to reach RUNNING before giving up (~5 min). Generous enough to ride
 * out a cold start without hanging an interactive CLI invocation indefinitely.
 */
const PREFLIGHT_WAIT_MAX_MS = 300_000;

/**
 * Regex breakdown:
 *   '(?:[^']|'')*'   — matches a SQL string literal, including escaped '' pairs
 *   |                 — alternation: whichever branch matches first at a position wins
 *   --[^\n]*          — matches a single-line SQL comment
 *
 * Because the regex engine scans left-to-right, a `'` is consumed as a string
 * literal before any `--` inside it could match as a comment — giving us
 * correct single-pass ordering without a manual state machine.
 *
 * V1: no block-comment support (deferred to next PR).
 */
const PROTECTED_RANGE_RE = /'(?:[^']|'')*'|--[^\n]*/g;

/**
 * Numeric-context patterns for positional type inference.
 * Hoisted to module scope — safe because matchAll() clones the regex internally.
 */
const NUMERIC_PATTERNS: RegExp[] = [
  /\bLIMIT\s+:([a-zA-Z_]\w*)/gi,
  /\bOFFSET\s+:([a-zA-Z_]\w*)/gi,
  /\bTOP\s+:([a-zA-Z_]\w*)/gi,
  /\bFETCH\s+FIRST\s+:([a-zA-Z_]\w*)\s+ROWS/gi,
  // V1 limitation: arithmetic operators may false-positive for date
  // expressions like `:start_date - INTERVAL '1 day'`. A smarter
  // heuristic (e.g. look-ahead for INTERVAL) is deferred to a future PR.
  /[+\-*/]\s*:([a-zA-Z_]\w*)/g,
  /:([a-zA-Z_]\w*)\s*[+\-*/]/g,
];

export function getProtectedRanges(sql: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const m of sql.matchAll(PROTECTED_RANGE_RE)) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

function isInsideProtectedRange(
  offset: number,
  ranges: Array<[number, number]>,
): boolean {
  return ranges.some(([start, end]) => offset >= start && offset < end);
}

/**
 * Parse a raw API/SDK error into a structured code + message.
 * Handles Databricks-style JSON bodies embedded in the message string,
 * e.g. `Response from server (Bad Request) {"error_code":"...","message":"..."}`.
 */
function parseError(raw: string): { code?: string; message: string } {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.error_code || parsed.message) {
        return {
          code: parsed.error_code,
          message: parsed.message || raw,
        };
      }
    } catch {
      // not valid JSON, fall through
    }
  }
  return { message: raw };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isObject(error) && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}

function getErrorDiagnostic(error: unknown): string {
  const seen = new Set<unknown>();
  const messages: string[] = [];
  const stack = [error];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);

    const message = getErrorMessage(current);
    if (
      message &&
      message !== "[object Object]" &&
      !messages.includes(message)
    ) {
      messages.push(message);
    }

    const code = getErrorCode(current);
    if (code && !messages.includes(code)) messages.push(code);

    stack.push(...getErrorChildren(current));
  }

  return messages.length > 0 ? messages.join(": ") : getErrorMessage(error);
}

function getErrorCode(error: unknown): string | undefined {
  if (!isObject(error)) return undefined;
  const code = error.code ?? error.errno;
  return typeof code === "string" ? code : undefined;
}

function getErrorStatus(error: unknown): number | undefined {
  if (!isObject(error)) return undefined;
  const direct = error.status ?? error.statusCode;
  if (typeof direct === "number") return direct;
  if (isObject(error.response) && typeof error.response.status === "number") {
    return error.response.status;
  }
  return undefined;
}

function getErrorChildren(error: unknown): unknown[] {
  if (!isObject(error)) return [];
  const children: unknown[] = [];
  if ("cause" in error) children.push(error.cause);
  if (error instanceof AggregateError) children.push(...error.errors);
  return children;
}

const CONNECTIVITY_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EAI_NODATA",
  "EAI_NONAME",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

function isConnectivityMessage(message: string): boolean {
  return (
    /\bconnection (?:refused|reset|timed out)\b/i.test(message) ||
    /\bsocket hang up\b/i.test(message) ||
    /\bnetwork error\b/i.test(message) ||
    /\bcan'?t connect to\b/i.test(message) ||
    /\bcertificate has expired\b/i.test(message) ||
    /\bunable to verify the first certificate\b/i.test(message) ||
    /\bupstream connect error or disconnect\/reset before headers\b/i.test(
      message,
    )
  );
}

function isConnectivityError(error: unknown): boolean {
  const seen = new Set<unknown>();
  const stack = [error];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);

    const code = getErrorCode(current);
    if (
      code &&
      (CONNECTIVITY_ERROR_CODES.has(code) || code.startsWith("UND_ERR_"))
    ) {
      return true;
    }

    const status = getErrorStatus(current);
    if (status === 502 || status === 503 || status === 504) return true;

    if (isConnectivityMessage(getErrorMessage(current))) return true;

    stack.push(...getErrorChildren(current));
  }

  return false;
}

/**
 * Outcome of {@link ensureRunning}: either the warehouse is RUNNING and the
 * caller should DESCRIBE (`ok: true`), or it can't serve this run and the caller
 * should fail with `reason`. Connectivity failures are NOT represented here —
 * they propagate as thrown errors so the caller's existing `isConnectivityError`
 * branch degrades them silently (a transient outage must never fail a build).
 */
type EnsureRunningResult = { ok: true } | { ok: false; reason: string };

/**
 * Single owner of "get this warehouse to RUNNING (or decide it can't)" for the
 * blocking preflight. Collapses what used to be two near-duplicate branches
 * (start-then-wait for a stopped warehouse, wait for a starting one) into one
 * routine, fixing two problems they shared:
 *
 *  1. Correctness: a STARTING→STOPPED regression mid-wait used to be treated as
 *     fatal, even though the warehouse merely needs (re)starting. Here, a
 *     non-terminal STOPPED/STOPPING reading loops back to a fresh start + wait
 *     under the SAME overall deadline, so the only blocking-mode fatals are a
 *     genuinely terminal warehouse (DELETED/DELETING) and a real wait-timeout.
 *  2. Security (CWE-209): the fatal messages here are sanitized — a deleted
 *     warehouse or a timeout, never a raw SDK/host diagnostic dump. Auth/config
 *     errors (and connectivity) are surfaced as throws for the caller to
 *     classify, so this routine never embeds untrusted error text.
 *
 * Classification per observed state:
 *  - DELETED / DELETING → fatal (can't be started; terminal).
 *  - RUNNING → ok (describe now).
 *  - STOPPED / STOPPING → nudge it with {@link startWarehouse}, then wait. We
 *    pass `treatStoppedAsTransient` so the stale pre-start STOPPED reading the
 *    start hasn't propagated past yet rides out instead of bailing the wait.
 *  - STARTING (or any other non-RUNNING state) → already coming up; wait without
 *    a redundant start. If it regresses to STOPPED, the wait surfaces it and the
 *    loop restarts it on the next pass.
 *
 * Everything runs under one `maxMs` deadline shared across loop iterations, so a
 * regression-driven restart can't extend the budget. A genuine timeout resolves
 * to a fatal with a distinct, sanitized message (no raw error text).
 *
 * @param report - optional caller sink for a one-time "still waiting" notice
 *   (console for the CLI `--wait` path; `logger.debug`/no-op for dev). Wrapped in
 *   a once-guard here so it fires at most once even across restart loops.
 * @throws any non-timeout error from the SDK (auth, connectivity, abort) — the
 *   caller classifies it (connectivity → degrade, otherwise → sanitized fatal).
 */
async function ensureRunning(
  client: WorkspaceClient,
  warehouseId: string,
  opts: { maxMs: number; signal?: AbortSignal; report?: (msg: string) => void },
): Promise<EnsureRunningResult> {
  const { maxMs, signal, report } = opts;
  const deadline = Date.now() + maxMs;

  // Fire the caller's "still waiting" notice at most once across the whole
  // routine, even if a regression makes us loop through several waitUntilRunning
  // calls (each of which would otherwise report on its own first poll).
  let reported = false;
  const reportOnce = report
    ? (msg: string) => {
        if (reported) return;
        reported = true;
        report(msg);
      }
    : undefined;

  // Distinct, sanitized timeout fatal: seconds only, no last-observed state or
  // raw SDK text (CWE-209). Used both for the between-iteration budget check and
  // for a timeout thrown from inside waitUntilRunning.
  const timeoutReason = (): EnsureRunningResult => ({
    ok: false,
    reason: `warehouse ${warehouseId} did not reach RUNNING within ${Math.round(
      maxMs / 1000,
    )}s`,
  });

  while (true) {
    const state = await getWarehouseState(client, warehouseId);

    // Terminal: a deleted/deleting warehouse genuinely can't reach RUNNING.
    if (state === "DELETED" || state === "DELETING") {
      return { ok: false, reason: `warehouse ${warehouseId} is ${state}` };
    }

    if (state === "RUNNING") return { ok: true };

    // Out of budget before we could even (re)start it → sanitized timeout fatal.
    const remaining = deadline - Date.now();
    if (remaining <= 0) return timeoutReason();

    // Stopped/stopping won't come up on its own — nudge it, and ride out the
    // stale pre-start STOPPED reading. STARTING (or any other non-RUNNING state)
    // is already coming up, so wait without a redundant start.
    const startedByUs = state === "STOPPED" || state === "STOPPING";
    if (startedByUs) {
      await startWarehouse(client, warehouseId);
    }

    let final: WarehouseState;
    try {
      final = await waitUntilRunning(client, warehouseId, {
        maxMs: remaining,
        signal,
        treatStoppedAsTransient: startedByUs,
        report: reportOnce,
      });
    } catch (err) {
      // A genuine wait-timeout becomes the sanitized timeout fatal here, so the
      // raw "(last state: …)" detail never escapes. Every other error
      // (connectivity, auth, abort) propagates to the caller's preflight catch,
      // which degrades connectivity and sanitizes the rest.
      if (err instanceof Error && err.name === WAREHOUSE_WAIT_TIMEOUT) {
        return timeoutReason();
      }
      throw err;
    }

    if (final === "RUNNING") return { ok: true };

    // A deleted/deleting warehouse surfaced mid-wait is terminal.
    if (final === "DELETED" || final === "DELETING") {
      return { ok: false, reason: `warehouse ${warehouseId} is ${final}` };
    }

    // Otherwise `final` is a STOPPED/STOPPING regression (only reachable when we
    // did NOT start it this pass — a STARTING→STOPPED drop). Loop: the next pass
    // re-reads, restarts it, and keeps waiting under the same deadline.
  }
}

/**
 * Build a sanitized fatal message for a blocking-preflight error that is neither
 * connectivity (degraded) nor a clean {@link ensureRunning} decision — i.e. an
 * auth, permission, bad-warehouse-id, or SDK-config failure. Deliberately does
 * NOT embed {@link getErrorDiagnostic} (which can leak SDK/host internals,
 * CWE-209): the actionable next step is the same regardless of the raw text, and
 * the full diagnostic is already available via debug logging.
 */
function sanitizedPreflightFatal(warehouseId: string): string {
  return `warehouse ${warehouseId} is not accessible (check the warehouse ID, permissions, and authentication)`;
}

/**
 * Extract parameters from a SQL query
 * @param sql - the SQL query to extract parameters from
 * @returns an array of parameter names
 */
export function extractParameters(
  sql: string,
  ranges?: Array<[number, number]>,
): string[] {
  const protectedRanges = ranges ?? getProtectedRanges(sql);
  const matches = sql.matchAll(/(?<!:):([a-zA-Z_]\w*)/g);
  const params = new Set<string>();
  for (const match of matches) {
    if (!isInsideProtectedRange(match.index, protectedRanges)) {
      params.add(match[1]);
    }
  }
  return Array.from(params);
}

// parameters that are injected by the server
export const SERVER_INJECTED_PARAMS = ["workspaceId"];

/**
 * Generates the TypeScript type literal for query parameters from SQL.
 * Shared by both the success and failure paths.
 */
function formatParametersType(sql: string): string {
  const params = extractParameters(sql).filter(
    (p) => !SERVER_INJECTED_PARAMS.includes(p),
  );
  const paramTypes = extractParameterTypes(sql);

  return params.length > 0
    ? `{\n      ${params
        .map((p) => {
          const sqlType = paramTypes[p];
          const markerType = sqlType
            ? sqlTypeToMarker[sqlType]
            : "SQLTypeMarker";
          const helper = sqlType ? sqlTypeToHelper[sqlType] : "sql.*()";
          return `/** ${sqlType || "any"} - use ${helper} */\n      ${p}: ${markerType}`;
        })
        .join(";\n      ")};\n    }`
    : "Record<string, never>";
}

export function convertToQueryType(
  result: DatabricksStatementExecutionResponse,
  sql: string,
  queryName: string,
): { type: string; hasResults: boolean } {
  const dataRows = result.result?.data_array || [];
  const columns = dataRows.map((row) => ({
    name: row[0] || "",
    type_name: row[1]?.toUpperCase() || "STRING",
    comment: row[2] || undefined,
  }));

  const paramsType = formatParametersType(sql);

  // generate result fields with JSDoc
  const resultFields = columns.map((column) => {
    const normalizedType = normalizeTypeName(column.type_name);
    const mappedType = typeMap[normalizedType] || "unknown";
    // validate column name is a valid identifier
    const name = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(column.name)
      ? column.name
      : `"${column.name}"`;

    // generate comment for column
    const comment = column.comment
      ? `/** ${column.comment} */\n      `
      : `/** @sqlType ${column.type_name} */\n      `;

    return `${comment}${name}: ${mappedType}`;
  });

  const hasResults = resultFields.length > 0;

  const type = `{
    name: "${queryName}";
    parameters: ${paramsType};
    result: ${
      hasResults
        ? `Array<{
      ${resultFields.join(";\n      ")};
    }>`
        : "unknown"
    };
  }`;

  return { type, hasResults };
}

/**
 * Used when DESCRIBE QUERY fails so the query still appears in QueryRegistry.
 * Generates a type with unknown result from SQL alone (no warehouse call).
 */
function generateUnknownResultQuery(sql: string, queryName: string): string {
  const paramsType = formatParametersType(sql);

  return `{
    name: "${queryName}";
    parameters: ${paramsType};
    result: unknown;
  }`;
}

/**
 * Degrade gracefully when DESCRIBE can't produce a fresh schema (transient
 * connectivity outage, or a warehouse that's reachable but not ready). Reuse
 * the last-good cached type when the SQL hash is unchanged, otherwise emit
 * `unknown` from SQL alone. Never persists `result: unknown`.
 */
function degradedType(
  cache: Awaited<ReturnType<typeof loadCache>>,
  queryName: string,
  sql: string,
  sqlHash: string,
): string {
  const prior = cache.queries[queryName];
  const canReusePrior = prior?.hash === sqlHash && !prior.retry;
  return canReusePrior
    ? prior.type
    : generateUnknownResultQuery(sql, queryName);
}

export function extractParameterTypes(sql: string): Record<string, string> {
  const paramTypes: Record<string, string> = {};
  // Alternation order matters: TIMESTAMP_NTZ must precede TIMESTAMP so the
  // regex engine doesn't greedy-match TIMESTAMP and leave `_NTZ` unconsumed.
  const regex =
    /--\s*@param\s+(\w+)\s+(STRING|NUMERIC|DECIMAL|BIGINT|TINYINT|SMALLINT|INT|FLOAT|DOUBLE|BOOLEAN|DATE|TIMESTAMP_NTZ|TIMESTAMP|BINARY)\b/gi;
  const matches = sql.matchAll(regex);
  for (const match of matches) {
    const [, paramName, paramType] = match;
    paramTypes[paramName] = paramType.toUpperCase();
  }

  return paramTypes;
}

export function defaultForType(sqlType: string | undefined): string {
  switch (sqlType?.toUpperCase()) {
    case "NUMERIC":
    case "DECIMAL":
    case "BIGINT":
    case "TINYINT":
    case "SMALLINT":
    case "INT":
      return "0";
    case "FLOAT":
    case "DOUBLE":
      return "0.0";
    case "STRING":
      return "''";
    case "BOOLEAN":
      return "true";
    case "DATE":
      return "'2000-01-01'";
    case "TIMESTAMP":
      return "'2000-01-01T00:00:00Z'";
    case "TIMESTAMP_NTZ":
      return "'2000-01-01T00:00:00'";
    case "BINARY":
      return "X'00'";
    default:
      return "''";
  }
}

/**
 * Infer parameter types from positional context in SQL.
 * V1 only infers NUMERIC from patterns like LIMIT, OFFSET, TOP,
 * FETCH FIRST ... ROWS, and arithmetic operators.
 * Parameters inside string literals or SQL comments are ignored.
 */
export function inferParameterTypes(
  sql: string,
  ranges?: Array<[number, number]>,
): Record<string, string> {
  const inferred: Record<string, string> = {};
  const protectedRanges = ranges ?? getProtectedRanges(sql);

  for (const pattern of NUMERIC_PATTERNS) {
    for (const match of sql.matchAll(pattern)) {
      if (!isInsideProtectedRange(match.index, protectedRanges)) {
        inferred[match[1]] = "NUMERIC";
      }
    }
  }

  return inferred;
}

/**
 * Generate query schemas from a folder of SQL files
 * It uses DESCRIBE QUERY to get the schema without executing the query
 * @param queryFolder - the folder containing the SQL files
 * @param warehouseId - the warehouse id to use for schema analysis
 * @param options - options for the query generation
 * @param options.noCache - if true, skip the cache and regenerate all types
 * @param options.mode - preflight policy: "non-blocking" never probes the
 *   warehouse and never describes (emits cached/`unknown` types and returns
 *   immediately), "blocking" waits for a starting warehouse and starts (then
 *   waits for) a stopped one, treating only a deleted/deleting warehouse as
 *   fatal. Defaults to "non-blocking".
 * @param options.report - optional sink for the one-time "still waiting for the
 *   warehouse" notice during a blocking cold start. The CLI `--wait` path passes
 *   a console printer so a multi-minute wait isn't silent; dev/non-CLI callers
 *   omit it and fall back to `logger.debug` (quiet on stdout). Caller-supplied so
 *   the library stays pure.
 * @returns an array of query schemas
 */
export async function generateQueriesFromDescribe(
  queryFolder: string,
  warehouseId: string,
  options: {
    noCache?: boolean;
    concurrency?: number;
    mode?: PreflightMode;
    report?: (msg: string) => void;
  } = {},
): Promise<QueryGenerationResult> {
  const {
    noCache = false,
    concurrency: rawConcurrency = 10,
    mode = "non-blocking",
    // Default to debug logging so a dev/watch caller that doesn't wire a reporter
    // stays quiet on stdout but the notice is still discoverable with DEBUG on.
    report = (msg: string) => logger.debug("%s", msg),
  } = options;
  const concurrency =
    typeof rawConcurrency === "number" && Number.isFinite(rawConcurrency)
      ? Math.max(1, Math.floor(rawConcurrency))
      : 10;

  // read all query files and cache in parallel
  const [allFiles, cache] = await Promise.all([
    fs.readdir(queryFolder),
    noCache
      ? ({ version: CACHE_VERSION, queries: {} } as Awaited<
          ReturnType<typeof loadCache>
        >)
      : loadCache(),
  ]);

  const queryFiles = allFiles.filter((file) => file.endsWith(".sql"));
  logger.debug("Found %d SQL queries", queryFiles.length);

  const client = new WorkspaceClient({});
  const spinner = new Spinner();

  // Read all SQL files in parallel
  const sqlContents = await Promise.all(
    queryFiles.map((file) => fs.readFile(path.join(queryFolder, file), "utf8")),
  );

  const startTime = performance.now();

  // Phase 1: Check cache, separate cached vs uncached
  const cachedResults: Array<{ index: number; schema: QuerySchema }> = [];
  const uncachedQueries: Array<{
    index: number;
    queryName: string;
    sql: string;
    sqlHash: string;
    cleanedSql: string;
  }> = [];
  const logEntries: Array<{
    queryName: string;
    status: "HIT" | "MISS";
    // Absent for clean hits/misses. "syntax" = bad SQL on a reachable warehouse;
    // "connectivity" = warehouse unreachable; "empty" = described but no columns;
    // "fatal" = non-SQL setup/request failure surfaced after .d.ts emission.
    kind?: "syntax" | "connectivity" | "empty" | "fatal";
    error?: { code?: string; message: string };
  }> = [];

  for (let i = 0; i < queryFiles.length; i++) {
    const file = queryFiles[i];
    const rawName = path.basename(file, ".sql");
    const queryName = normalizeQueryName(rawName);

    const sql = sqlContents[i];
    const sqlHash = hashSQL(sql);

    const cached = cache.queries[queryName];
    if (cached && cached.hash === sqlHash && !cached.retry) {
      cachedResults.push({
        index: i,
        schema: { name: queryName, type: cached.type },
      });
      logEntries.push({ queryName, status: "HIT" });
    } else {
      const protectedRanges = getProtectedRanges(sql);
      const annotatedTypes = extractParameterTypes(sql);
      const inferredTypes = inferParameterTypes(sql, protectedRanges);
      const parameterTypes = { ...inferredTypes, ...annotatedTypes };
      const sqlWithDefaults = sql.replace(
        /(?<!:):([a-zA-Z_]\w*)/g,
        (original, paramName, offset) => {
          if (isInsideProtectedRange(offset, protectedRanges)) {
            return original;
          }
          return defaultForType(parameterTypes[paramName]);
        },
      );

      // Warn about unresolved parameters
      const allParams = extractParameters(sql, protectedRanges);
      for (const param of allParams) {
        if (SERVER_INJECTED_PARAMS.includes(param)) continue;
        if (parameterTypes[param]) continue;
        logger.warn(
          '%s: parameter ":%s" has no type annotation or inference. Add %s to the query file.',
          queryFiles[i],
          param,
          `-- @param ${param} <TYPE>`,
        );
      }

      const cleanedSql = sqlWithDefaults.trim().replace(/;\s*$/, "");
      uncachedQueries.push({ index: i, queryName, sql, sqlHash, cleanedSql });
    }
  }

  // Phase 2: Execute all uncached DESCRIBE calls in parallel
  type DescribeResult =
    | {
        // Described successfully with a result schema — the only case we cache.
        status: "ok";
        index: number;
        schema: QuerySchema;
        cacheEntry: { hash: string; type: string; retry: boolean };
      }
    | {
        // Reachable warehouse ran DESCRIBE and rejected the statement — a
        // genuine SQL error. Eligible to fail the build; never cached.
        status: "syntax";
        index: number;
        schema: QuerySchema;
        error: { code?: string; message: string };
      }
    | {
        // DESCRIBE succeeded but returned no columns — soft `unknown`. Not a
        // failure, not cached, retried next run.
        status: "empty";
        index: number;
        schema: QuerySchema;
      }
    | {
        // Warehouse reachable but returned a non-terminal state (PENDING/
        // RUNNING) with no rows — stopped/cold-starting/busy. Degrade like a
        // transient outage (reuse cache or `unknown`); not cached, not empty.
        status: "unavailable";
        index: number;
        schema: QuerySchema;
      };

  const freshResults: Array<{ index: number; schema: QuerySchema }> = [];
  // Genuine SQL errors (reachable warehouse). Connectivity failures are NOT
  // recorded here — they degrade silently so a transient outage isn't fatal.
  const syntaxErrors: QuerySyntaxError[] = [];
  const fatalErrors: QueryFatalError[] = [];

  if (uncachedQueries.length > 0) {
    // One-time warehouse preflight (before issuing any DESCRIBE). A single
    // warehouses.get classifies the warehouse so we can skip the whole describe
    // batch when it can't serve this run, instead of letting every query fail
    // (and re-fail next run). Reuses this file's degrade/classify helpers so a
    // not-ready warehouse degrades exactly like a per-query outage.
    let decision: ReturnType<typeof decidePreflight> = "proceed";
    let fatalMessage = "";
    if (mode === "non-blocking") {
      // `non-blocking` never describes and must make ZERO warehouse round-trips:
      // skip the probe entirely (no getWarehouseState) and go straight to
      // degradeAll. A foreground/one-shot run can't describe in the background,
      // so it emits best-available types (reused cache or `unknown`) and returns
      // now.
      decision = "degradeAll";
    } else {
      try {
        const state = await getWarehouseState(client, warehouseId);
        decision = decidePreflight(state, mode);
        if (decision === "fatal") {
          fatalMessage = `warehouse ${warehouseId} is ${state}`;
        }
        // Both "start a stopped warehouse then wait" and "wait for a starting
        // one" collapse into a single readiness owner: ensureRunning starts the
        // warehouse if needed, polls to RUNNING under one deadline, restarts on a
        // STARTING→STOPPED regression, and treats only a deleted warehouse or a
        // genuine timeout as fatal (with a sanitized message — no raw SDK text).
        if (decision === "startWaitProceed" || decision === "waitThenProceed") {
          const result = await ensureRunning(client, warehouseId, {
            maxMs: PREFLIGHT_WAIT_MAX_MS,
            report,
          });
          if (result.ok) {
            decision = "proceed";
          } else {
            decision = "fatal";
            fatalMessage = result.reason;
          }
        }
      } catch (err) {
        if (isConnectivityError(err)) {
          // Warehouse unreachable (transient outage): degrade silently like a
          // per-query connectivity failure — never fail a build on a blip. The
          // raw diagnostic is still available at debug level for investigation.
          logger.debug("Warehouse preflight connectivity failure: %O", err);
          decision = "degradeAll";
        } else {
          // Auth, bad warehouse id, or malformed SDK config: fatal. Keep the
          // user-facing message sanitized (no raw SDK/host diagnostic dump,
          // CWE-209) and route the full diagnostic to debug logging instead.
          logger.debug(
            "Warehouse preflight fatal: %s",
            getErrorDiagnostic(err),
          );
          decision = "fatal";
          fatalMessage = sanitizedPreflightFatal(warehouseId);
        }
      }
    }

    if (decision !== "proceed") {
      // degradeAll or fatal: skip DESCRIBE entirely. Every uncached query gets a
      // degraded schema (reused cache or `unknown`); fatal additionally records
      // a fatalError per query so the caller fails the build after writing.
      const kind = decision === "fatal" ? "fatal" : "connectivity";
      for (const { index, queryName, sql, sqlHash } of uncachedQueries) {
        freshResults.push({
          index,
          schema: {
            name: queryName,
            type: degradedType(cache, queryName, sql, sqlHash),
          },
        });
        if (decision === "fatal") {
          fatalErrors.push({ name: queryName, message: fatalMessage });
          logEntries.push({
            queryName,
            status: "MISS",
            kind,
            error: { message: fatalMessage },
          });
        } else {
          logEntries.push({ queryName, status: "MISS", kind });
        }
      }
    } else {
      let completed = 0;
      const total = uncachedQueries.length;
      spinner.start(
        `Describing ${total} ${total === 1 ? "query" : "queries"} (0/${total})`,
      );

      const describeOne = async ({
        index,
        queryName,
        sql,
        sqlHash,
        cleanedSql,
      }: (typeof uncachedQueries)[number]): Promise<DescribeResult> => {
        const result = (await client.statementExecution.executeStatement({
          statement: `DESCRIBE QUERY ${cleanedSql}`,
          warehouse_id: warehouseId,
        })) as DatabricksStatementExecutionResponse;

        completed++;
        spinner.update(
          `Describing ${total} ${total === 1 ? "query" : "queries"} (${completed}/${total})`,
        );

        logger.debug(
          "DESCRIBE result for %s: state=%s, rows=%d",
          queryName,
          result.status.state,
          result.result?.data_array?.length ?? 0,
        );

        if (result.status.state === "FAILED") {
          // The warehouse was reachable and ran DESCRIBE, but the statement
          // failed — a genuine SQL error (bad table, syntax, incompatible type).
          const sqlError =
            result.status.error?.message || "Query execution failed";
          // The failure is surfaced once, formatted, by the aggregated
          // TypegenSyntaxError (and the summary table) — don't also log the raw
          // message here or every SQL error prints twice in dev.
          const type = generateUnknownResultQuery(sql, queryName);
          return {
            status: "syntax",
            index,
            schema: { name: queryName, type },
            error: parseError(sqlError),
          };
        }

        if (result.status.state !== "SUCCEEDED") {
          // Non-terminal state (PENDING/RUNNING) with no result rows: the
          // warehouse is reachable but not ready (stopped, cold-starting, or
          // busy). Degrade like a transient outage — reuse the last-good cached
          // type when the SQL is unchanged, else emit `unknown`. Never "empty":
          // treating this as empty would emit `result: unknown` AND discard the
          // good cached type, silently throwing away working types.
          return {
            status: "unavailable",
            index,
            schema: {
              name: queryName,
              type: degradedType(cache, queryName, sql, sqlHash),
            },
          };
        }

        const { type, hasResults } = convertToQueryType(result, sql, queryName);
        if (!hasResults) {
          // Described, but no result columns. Emit `unknown` and retry next run;
          // do not cache (we never persist `result: unknown`).
          return { status: "empty", index, schema: { name: queryName, type } };
        }
        return {
          status: "ok",
          index,
          schema: { name: queryName, type },
          cacheEntry: { hash: sqlHash, type, retry: false },
        };
      };

      // Process in chunks, saving cache after each chunk
      const processBatchResults = (
        settled: PromiseSettledResult<DescribeResult>[],
        batchOffset: number,
      ) => {
        for (let i = 0; i < settled.length; i++) {
          const entry = settled[i];
          const { queryName } = uncachedQueries[batchOffset + i];

          if (entry.status === "fulfilled") {
            const res = entry.value;
            freshResults.push({ index: res.index, schema: res.schema });

            if (res.status === "ok") {
              // Only a successful describe with a result schema is cached.
              cache.queries[queryName] = res.cacheEntry;
              logEntries.push({ queryName, status: "MISS" });
            } else if (res.status === "syntax") {
              // Genuine SQL error — record it for the caller's prod/dev gate.
              // Not cached: re-described next run so a fixed query recovers.
              syntaxErrors.push({
                name: queryName,
                message: res.error.message,
              });
              logEntries.push({
                queryName,
                status: "MISS",
                kind: "syntax",
                error: res.error,
              });
            } else if (res.status === "empty") {
              // status === "empty": described, no columns. Soft unknown, not cached.
              logEntries.push({ queryName, status: "MISS", kind: "empty" });
            } else {
              // status === "unavailable": non-terminal DESCRIBE (warehouse
              // stopped/cold-starting/busy). Degrade like a transient outage:
              // tag OFFLINE, count as degraded, never cache.
              logEntries.push({
                queryName,
                status: "MISS",
                kind: "connectivity",
              });
            }
          } else {
            // executeStatement rejected without a normal StatementExecution result.
            // Only structured transport/connectivity failures are treated as
            // offline; auth, bad warehouse IDs, malformed requests, and SDK/config
            // failures stay fatal so users fix the underlying setup issue.
            completed++;
            spinner.update(
              `Describing ${total} ${total === 1 ? "query" : "queries"} (${completed}/${total})`,
            );

            const { sql, sqlHash, index } = uncachedQueries[batchOffset + i];
            const reason = getErrorDiagnostic(entry.reason);
            const error = parseError(reason);
            const priorEntry = cache.queries[queryName];
            const canReusePrior =
              priorEntry?.hash === sqlHash && !priorEntry.retry;
            const type = degradedType(cache, queryName, sql, sqlHash);
            freshResults.push({ index, schema: { name: queryName, type } });

            if (!isConnectivityError(entry.reason)) {
              fatalErrors.push({ name: queryName, message: error.message });
              logEntries.push({
                queryName,
                status: "MISS",
                kind: "fatal",
                error,
              });
              continue;
            }

            logger.warn(
              "DESCRIBE unreachable for %s: %s — %s",
              queryName,
              reason,
              canReusePrior
                ? "reusing last cached type"
                : "emitting unknown (no matching cache)",
            );
            logEntries.push({
              queryName,
              status: "MISS",
              kind: "connectivity",
              error,
            });
          }
        }
      };

      if (uncachedQueries.length > concurrency) {
        for (let b = 0; b < uncachedQueries.length; b += concurrency) {
          const batch = uncachedQueries.slice(b, b + concurrency);
          const batchResults = await Promise.allSettled(batch.map(describeOne));
          processBatchResults(batchResults, b);
          await saveCache(cache);
        }
      } else {
        const settled = await Promise.allSettled(
          uncachedQueries.map(describeOne),
        );
        processBatchResults(settled, 0);
        await saveCache(cache);
      }

      spinner.stop("");
    }
  }

  const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);

  // Print formatted table
  if (logEntries.length > 0) {
    const maxNameLen = Math.max(...logEntries.map((e) => e.queryName.length));
    const separator = pc.dim("─".repeat(50));
    console.log("");
    console.log(
      `  ${pc.bold("Typegen Queries")} ${pc.dim(`(${logEntries.length})`)}`,
    );
    console.log(`  ${separator}`);
    for (const entry of logEntries) {
      let tag: string;
      switch (entry.kind) {
        case "syntax":
          tag = pc.bold(pc.red("SQL ERR"));
          break;
        case "connectivity":
          tag = pc.bold(pc.yellow("OFFLINE"));
          break;
        case "empty":
          tag = pc.dim("EMPTY  ");
          break;
        case "fatal":
          tag = pc.bold(pc.red("FATAL "));
          break;
        default:
          tag =
            entry.status === "HIT"
              ? `cache ${pc.bold(pc.green("HIT  "))}`
              : `cache ${pc.bold(pc.yellow("MISS "))}`;
      }
      const rawName = entry.queryName.padEnd(maxNameLen);
      // Only genuine SQL errors are struck through. Connectivity/empty kept a
      // usable type (reused or unknown), so they read as degraded, not broken.
      const name =
        entry.kind === "syntax" || entry.kind === "fatal"
          ? pc.dim(pc.strikethrough(rawName))
          : rawName;
      const errorCode = entry.error?.message.match(/\[([^\]]+)\]/)?.[1];
      const reason = errorCode ? `  ${pc.dim(errorCode)}` : "";
      console.log(`  ${tag}  ${name}${reason}`);
    }
    const newCount = logEntries.filter(
      (e) => e.status === "MISS" && !e.kind,
    ).length;
    const cacheCount = logEntries.filter((e) => e.status === "HIT").length;
    const syntaxCount = logEntries.filter((e) => e.kind === "syntax").length;
    const offlineCount = logEntries.filter(
      (e) => e.kind === "connectivity",
    ).length;
    const emptyCount = logEntries.filter((e) => e.kind === "empty").length;
    const fatalCount = logEntries.filter((e) => e.kind === "fatal").length;
    console.log(`  ${separator}`);
    const parts = [`${newCount} new`, `${cacheCount} from cache`];
    if (syntaxCount > 0)
      parts.push(
        `${syntaxCount} SQL ${syntaxCount === 1 ? "error" : "errors"}`,
      );
    if (offlineCount > 0) parts.push(`${offlineCount} degraded`);
    if (emptyCount > 0) parts.push(`${emptyCount} empty`);
    if (fatalCount > 0)
      parts.push(
        `${fatalCount} fatal ${fatalCount === 1 ? "error" : "errors"}`,
      );
    console.log(`  ${parts.join(", ")}. ${pc.dim(`${elapsed}s`)}`);
    console.log("");
  }

  // Merge and sort by original file index for deterministic output
  const schemas = [...cachedResults, ...freshResults]
    .sort((a, b) => a.index - b.index)
    .map((r) => r.schema);

  return { schemas, syntaxErrors, fatalErrors };
}

/**
 * Normalize query name by removing the .obo extension
 * @param queryName - the query name to normalize
 * @returns the normalized query name
 */
function normalizeQueryName(fileName: string): string {
  return fileName.replace(/\.obo$/, "");
}

/**
 * Normalize SQL type name by removing parameters/generics
 * Examples:
 *   DECIMAL(38,6) -> DECIMAL
 *   ARRAY<STRING> -> ARRAY
 *   MAP<STRING,INT> -> MAP
 *   STRUCT<name:STRING> -> STRUCT
 *   INTERVAL DAY TO SECOND -> INTERVAL
 *   GEOGRAPHY(4326) -> GEOGRAPHY
 */
export function normalizeTypeName(typeName: string): string {
  return typeName
    .replace(/\(.*\)$/, "") // remove (p, s) eg: DECIMAL(38,6) -> DECIMAL
    .replace(/<.*>$/, "") // remove <T> eg: ARRAY<STRING> -> ARRAY
    .split(" ")[0]; // take first word eg: INTERVAL DAY TO SECOND -> INTERVAL
}

/** Type Map for Databricks data types to JavaScript types */
const typeMap: Record<string, string> = {
  // string types
  STRING: "string",
  BINARY: "string",
  // boolean
  BOOLEAN: "boolean",
  // numeric types
  TINYINT: "number",
  SMALLINT: "number",
  INT: "number",
  BIGINT: "number",
  FLOAT: "number",
  DOUBLE: "number",
  DECIMAL: "number",
  // date/time types
  DATE: "string",
  TIMESTAMP: "string",
  TIMESTAMP_NTZ: "string",
  INTERVAL: "string",
  // complex types
  ARRAY: "unknown[]",
  MAP: "Record<string, unknown>",
  STRUCT: "Record<string, unknown>",
  OBJECT: "Record<string, unknown>",
  VARIANT: "unknown",
  // spatial types
  GEOGRAPHY: "unknown",
  GEOMETRY: "unknown",
  // null type
  VOID: "null",
};
