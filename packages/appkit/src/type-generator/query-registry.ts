import fs from "node:fs/promises";
import path from "node:path";
import { WorkspaceClient } from "@databricks/sdk-experimental";
import pc from "picocolors";
import { createLogger } from "../logging/logger";
import { CACHE_VERSION, hashSQL, loadCache, saveCache } from "./cache";
import { Spinner } from "./spinner";
import {
  type DatabricksStatementExecutionResponse,
  type QuerySchema,
  sqlTypeToHelper,
  sqlTypeToMarker,
} from "./types";

const logger = createLogger("type-generator:query-registry");

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

export function extractParameterTypes(sql: string): Record<string, string> {
  const paramTypes: Record<string, string> = {};
  const regex =
    /--\s*@param\s+(\w+)\s+(STRING|NUMERIC|BOOLEAN|DATE|TIMESTAMP|BINARY)/gi;
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
      return "0";
    case "STRING":
      return "''";
    case "BOOLEAN":
      return "true";
    case "DATE":
      return "'2000-01-01'";
    case "TIMESTAMP":
      return "'2000-01-01T00:00:00Z'";
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
 * @returns an array of query schemas
 */
export async function generateQueriesFromDescribe(
  queryFolder: string,
  warehouseId: string,
  options: { noCache?: boolean; concurrency?: number } = {},
): Promise<QuerySchema[]> {
  const { noCache = false, concurrency: rawConcurrency = 10 } = options;
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
    failed?: boolean;
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
        status: "ok";
        index: number;
        schema: QuerySchema;
        cacheEntry: { hash: string; type: string; retry: boolean };
      }
    | {
        status: "fail";
        index: number;
        schema: QuerySchema;
        cacheEntry: { hash: string; type: string; retry: boolean };
        error: { code?: string; message: string };
      };

  const freshResults: Array<{ index: number; schema: QuerySchema }> = [];

  if (uncachedQueries.length > 0) {
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
        const sqlError =
          result.status.error?.message || "Query execution failed";
        logger.warn("DESCRIBE failed for %s: %s", queryName, sqlError);
        const type = generateUnknownResultQuery(sql, queryName);
        return {
          status: "fail",
          index,
          schema: { name: queryName, type },
          cacheEntry: { hash: sqlHash, type, retry: true },
          error: parseError(sqlError),
        };
      }

      const { type, hasResults } = convertToQueryType(result, sql, queryName);
      return {
        status: "ok",
        index,
        schema: { name: queryName, type },
        cacheEntry: { hash: sqlHash, type, retry: !hasResults },
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
          cache.queries[queryName] = res.cacheEntry;
          logEntries.push({
            queryName,
            status: "MISS",
            failed: res.status === "fail",
            error: res.status === "fail" ? res.error : undefined,
          });
        } else {
          const { sql, sqlHash, index } = uncachedQueries[batchOffset + i];
          const reason =
            entry.reason instanceof Error
              ? entry.reason.message
              : String(entry.reason);
          logger.warn("DESCRIBE rejected for %s: %s", queryName, reason);
          const type = generateUnknownResultQuery(sql, queryName);
          freshResults.push({ index, schema: { name: queryName, type } });
          cache.queries[queryName] = { hash: sqlHash, type, retry: true };
          logEntries.push({
            queryName,
            status: "MISS",
            failed: true,
            error: parseError(reason),
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
      const tag = entry.failed
        ? pc.bold(pc.red("ERROR"))
        : entry.status === "HIT"
          ? `cache ${pc.bold(pc.green("HIT  "))}`
          : `cache ${pc.bold(pc.yellow("MISS "))}`;
      const rawName = entry.queryName.padEnd(maxNameLen);
      const name = entry.failed ? pc.dim(pc.strikethrough(rawName)) : rawName;
      const errorCode = entry.error?.message.match(/\[([^\]]+)\]/)?.[1];
      const reason = errorCode ? `  ${pc.dim(errorCode)}` : "";
      console.log(`  ${tag}  ${name}${reason}`);
    }
    const newCount = logEntries.filter(
      (e) => e.status === "MISS" && !e.failed,
    ).length;
    const cacheCount = logEntries.filter(
      (e) => e.status === "HIT" && !e.failed,
    ).length;
    const errorCount = logEntries.filter((e) => e.failed).length;
    console.log(`  ${separator}`);
    const parts = [`${newCount} new`, `${cacheCount} from cache`];
    if (errorCount > 0)
      parts.push(`${errorCount} ${errorCount === 1 ? "error" : "errors"}`);
    console.log(`  ${parts.join(", ")}. ${pc.dim(`${elapsed}s`)}`);
    console.log("");
  }

  // Merge and sort by original file index for deterministic output
  return [...cachedResults, ...freshResults]
    .sort((a, b) => a.index - b.index)
    .map((r) => r.schema);
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
