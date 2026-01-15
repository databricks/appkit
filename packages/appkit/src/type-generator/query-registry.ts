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

export function convertToQueryType(
  result: DatabricksStatementExecutionResponse,
  sql: string,
  queryName: string,
): string {
  const dataRows = result.result?.data_array || [];
  const columns = dataRows.map((row) => ({
    name: row[0] || "",
    type_name: row[1]?.toUpperCase() || "STRING",
    comment: row[2] || undefined,
  }));

  const params = extractParameters(sql).filter(
    (p) => !SERVER_INJECTED_PARAMS.includes(p),
  );

  const paramTypes = extractParameterTypes(sql);

  // generate parameters types with JSDoc hints
  const paramsType =
    params.length > 0
      ? `{\n      ${params
          .map((p) => {
            const sqlType = paramTypes[p];
            // if no type annotation, use SQLTypeMarker (union type)
            const markerType = sqlType
              ? sqlTypeToMarker[sqlType]
              : "SQLTypeMarker";
            const helper = sqlType ? sqlTypeToHelper[sqlType] : "sql.*()";
            return `/** ${sqlType || "any"} - use ${helper} */\n      ${p}: ${markerType}`;
          })
          .join(";\n      ")};\n    }`
      : "Record<string, never>";

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

  return `{
    name: "${queryName}";
    parameters: ${paramsType};
    result: Array<{
      ${resultFields.join(";\n      ")};
    }>;
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
  const querySchemas: QuerySchema[] = [];
  const failedQueries: { name: string; error: string }[] = [];
  const spinner = new Spinner();

  // process each query file
  for (let i = 0; i < queryFiles.length; i++) {
    const file = queryFiles[i];
    const queryName = path.basename(file, ".sql");

    // read query file content
    const sql = fs.readFileSync(path.join(queryFolder, file), "utf8");
    const sqlHash = hashSQL(sql);

    // check cache
    const cached = cache.queries[queryName];
    if (cached && cached.hash === sqlHash) {
      querySchemas.push({ name: queryName, type: cached.type });
      spinner.start(`Processing ${queryName} (${i + 1}/${queryFiles.length})`);
      spinner.stop(`✓ ${queryName} (cached)`);
      continue;
    }

    spinner.start(`Processing ${queryName} (${i + 1}/${queryFiles.length})`);

    const sqlWithDefaults = sql.replace(/:([a-zA-Z_]\w*)/g, "''");

    // strip trailing semicolon for DESCRIBE QUERY
    const cleanedSql = sqlWithDefaults.trim().replace(/;\s*$/, "");

    // execute DESCRIBE QUERY to get schema without running the actual query
    try {
      const result = (await client.statementExecution.executeStatement({
        statement: `DESCRIBE QUERY ${cleanedSql}`,
        warehouse_id: warehouseId,
      })) as DatabricksStatementExecutionResponse;

      if (result.status.state === "FAILED") {
        spinner.stop(`✗ ${queryName} - failed`);
        failedQueries.push({
          name: queryName,
          error: "Query execution failed",
        });
        continue;
      }

      // convert result to query schema
      const type = convertToQueryType(result, sql, queryName);
      querySchemas.push({ name: queryName, type });

      // update cache
      cache.queries[queryName] = { hash: sqlHash, type };

      spinner.stop(`✓ ${queryName}`);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      spinner.stop(`✗ ${queryName} - ${errorMessage}`);
      failedQueries.push({ name: queryName, error: errorMessage });
    }
  }

  // save cache
  saveCache(cache);

  // log warning if there are failed queries
  if (failedQueries.length > 0) {
    logger.debug("Warning: %d queries failed", failedQueries.length);
  }

  return querySchemas;
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
