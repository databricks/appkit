import { getRequestContext } from "@databricks-apps/server";
import type { sql } from "@databricks/sdk-experimental";
import { createHash } from "node:crypto";

export class QueryProcessor {
  async processQueryParams(
    query: string,
    parameters?: Record<string, any>,
  ): Promise<Record<string, any>> {
    const processed = { ...parameters };

    // extract all params from the query
    const paramMatches = query.matchAll(/:([a-zA-Z_]\w*)/g);
    const queryParams = new Set(Array.from(paramMatches, (m) => m[1]));

    // auto-inject workspaceId if needed and not provided
    if (queryParams.has("workspaceId") && !processed.workspaceId) {
      const requestContext = getRequestContext();
      const workspaceId = await requestContext.workspaceId;
      if (workspaceId) {
        processed.workspaceId = workspaceId;
      }
    }

    return processed;
  }

  hashQuery(query: string): string {
    return createHash("md5").update(query).digest("hex");
  }

  convertToSQLParameters(
    query: string,
    parameters?: Record<string, any>,
  ): { statement: string; parameters: sql.StatementParameterListItem[] } {
    const sqlParameters: sql.StatementParameterListItem[] = [];

    if (parameters) {
      // extract all params from the query
      const queryParamMatches = query.matchAll(/:([a-zA-Z_]\w*)/g);
      const queryParams = new Set(Array.from(queryParamMatches, (m) => m[1]));

      // only allow parameters that exist in the query
      for (const key of Object.keys(parameters)) {
        if (!queryParams.has(key)) {
          throw new Error(
            `Parameter "${key}" not found in query. Valid parameters: ${
              Array.from(queryParams).join(", ") || "none"
            }`,
          );
        }
      }

      // convert parameters to SQL parameters
      for (const [key, value] of Object.entries(parameters)) {
        const parameter = this._createParameter(key, value);
        if (parameter) {
          sqlParameters.push(parameter);
        }
      }
    }

    return { statement: query, parameters: sqlParameters };
  }

  private _createParameter(
    key: string,
    value: any,
  ): sql.StatementParameterListItem | null {
    if (value === null || value === undefined) {
      return null;
    }

    if (value === "" && key.includes("Filter")) {
      return null;
    }

    if (key.includes("Date") || key.includes("date")) {
      if (typeof value === "string") {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
          throw new Error(`Invalid date format for parameter ${key}: ${value}`);
        }
        return {
          name: key,
          value: value,
          type: "DATE",
        };
      }
      if (value instanceof Date) {
        return {
          name: key,
          value: value.toISOString().split("T")[0],
          type: "DATE",
        };
      }
    }

    if (key.includes("Time") || key.includes("timestamp")) {
      if (value instanceof Date) {
        return {
          name: key,
          value: value.toISOString(),
          type: "TIMESTAMP",
        };
      }

      return {
        name: key,
        value: String(value),
        type: "TIMESTAMP",
      };
    }

    if (key === "aggregationLevel") {
      const validLevels = ["hour", "day", "week", "month", "year"];
      if (!validLevels.includes(value)) {
        throw new Error(
          `Invalid aggregation level: ${value}. Must be one of: ${validLevels.join(
            ", ",
          )}`,
        );
      }
      return {
        name: key,
        value: value,
        type: "STRING",
      };
    }
    if (typeof value === "boolean") {
      return {
        name: key,
        value: String(value),
        type: "BOOLEAN",
      };
    }

    if (typeof value === "number") {
      return {
        name: key,
        value: String(value),
        type: "NUMERIC",
      };
    }

    return {
      name: key,
      value: String(value),
      type: "STRING",
    };
  }
}
