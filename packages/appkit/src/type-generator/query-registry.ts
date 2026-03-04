import fs from "node:fs";
import path from "node:path";
import { WorkspaceClient } from "@databricks/sdk-experimental";
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
 * Extract parameters from a SQL query
 * @param sql - the SQL query to extract parameters from
 * @returns an array of parameter names
 */
export function extractParameters(sql: string): string[] {
  const matches = sql.matchAll(/:([a-zA-Z_]\w*)/g);
  const params = new Set<string>();
  for (const match of matches) {
    params.add(match[1]);
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
  options: { noCache?: boolean } = {},
): Promise<QuerySchema[]> {
  const { noCache = false } = options;

  // read all query files in the folder
  const queryFiles = fs
    .readdirSync(queryFolder)
    .filter((file) => file.endsWith(".sql"));

  logger.debug("Found %d SQL queries", queryFiles.length);

  // load cache
  const cache = noCache ? { version: CACHE_VERSION, queries: {} } : loadCache();

  const client = new WorkspaceClient({});
  const spinner = new Spinner();

  // Phase 1: Read files, check cache, separate cached vs uncached
  const cachedResults: Array<{ index: number; schema: QuerySchema }> = [];
  const uncachedQueries: Array<{
    index: number;
    queryName: string;
    sql: string;
    sqlHash: string;
    cleanedSql: string;
  }> = [];

  for (let i = 0; i < queryFiles.length; i++) {
    const file = queryFiles[i];
    const rawName = path.basename(file, ".sql");
    const queryName = normalizeQueryName(rawName);

    const sql = fs.readFileSync(path.join(queryFolder, file), "utf8");
    const sqlHash = hashSQL(sql);

    const cached = cache.queries[queryName];
    if (cached && cached.hash === sqlHash && !cached.retry) {
      cachedResults.push({
        index: i,
        schema: { name: queryName, type: cached.type },
      });
      spinner.start(`Processing ${queryName} (${i + 1}/${queryFiles.length})`);
      spinner.stop(`✓ ${queryName} (cached)`);
    } else {
      const sqlWithDefaults = sql.replace(/:([a-zA-Z_]\w*)/g, "''");
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
        errorLines: string[];
      };

  const freshResults: Array<{ index: number; schema: QuerySchema }> = [];
  const startTime = performance.now();

  if (uncachedQueries.length > 0) {
    let completed = 0;
    const total = uncachedQueries.length;
    spinner.start(
      `Describing ${total} ${total === 1 ? "query" : "queries"} (0/${total})`,
    );

    const settled = await Promise.allSettled(
      uncachedQueries.map(
        async ({
          index,
          queryName,
          sql,
          sqlHash,
          cleanedSql,
        }): Promise<DescribeResult> => {
          const result = (await client.statementExecution.executeStatement({
            statement: `DESCRIBE QUERY ${cleanedSql}`,
            warehouse_id: warehouseId,
          })) as DatabricksStatementExecutionResponse;

          completed++;
          spinner.update(
            `Describing ${total} ${total === 1 ? "query" : "queries"} (${completed}/${total})`,
          );

          if (result.status.state === "FAILED") {
            const sqlError =
              result.status.error?.message || "Query execution failed";
            const type = generateUnknownResultQuery(sql, queryName);
            return {
              status: "fail",
              index,
              schema: { name: queryName, type },
              cacheEntry: { hash: sqlHash, type, retry: true },
              errorLines: [
                `SQL Error: ${sqlError}`,
                `Query: ${cleanedSql.slice(0, 200)}`,
              ],
            };
          }

          const { type, hasResults } = convertToQueryType(
            result,
            sql,
            queryName,
          );
          return {
            status: "ok",
            index,
            schema: { name: queryName, type },
            cacheEntry: { hash: sqlHash, type, retry: !hasResults },
          };
        },
      ),
    );

    spinner.stop(`✓ Described ${total} ${total === 1 ? "query" : "queries"}`);

    // Print per-query results
    for (let i = 0; i < settled.length; i++) {
      const entry = settled[i];
      const { queryName } = uncachedQueries[i];

      if (entry.status === "fulfilled") {
        const res = entry.value;
        freshResults.push({ index: res.index, schema: res.schema });
        cache.queries[queryName] = res.cacheEntry;

        if (res.status === "ok") {
          spinner.printDetail(`✓ ${queryName}`);
        } else {
          spinner.printDetail(`✗ ${queryName} - failed`);
          for (const line of res.errorLines) {
            spinner.printDetail(`  ${line}`);
          }
        }
      } else {
        const errorMessage =
          entry.reason instanceof Error
            ? entry.reason.message
            : "Unknown error";
        const { sql, sqlHash, index } = uncachedQueries[i];
        const type = generateUnknownResultQuery(sql, queryName);
        freshResults.push({ index, schema: { name: queryName, type } });
        cache.queries[queryName] = { hash: sqlHash, type, retry: true };

        spinner.printDetail(`✗ ${queryName}`);
        spinner.printDetail(`  ${errorMessage}`);
      }
    }

    // Save cache once after all queries are processed
    saveCache(cache);
  }

  const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
  logger.debug(
    "%d new queries, %d cached. Typegen: %ss",
    uncachedQueries.length,
    cachedResults.length,
    elapsed,
  );

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
export function normalizeQueryName(fileName: string): string {
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
