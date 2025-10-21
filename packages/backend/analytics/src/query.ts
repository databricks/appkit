import type { ParameterInput } from "@databricks-apps/connectors";

export class QueryProcessor {
  processQueryParams(
    query: string,
    parameters?: Record<string, any>,
  ): Record<string, any> {
    const processed = { ...parameters };

    // extract all params from the query
    const paramMatches = query.matchAll(/:([a-zA-Z_]\w*)/g);
    const queryParams = new Set(Array.from(paramMatches, (m) => m[1]));

    // auto-inject workspaceId if needed and not provided
    if (queryParams.has("workspaceId") && !processed.workspaceId) {
      const workspaceId = process.env.DATABRICKS_WORKSPACE_ID;
      if (workspaceId) {
        processed.workspaceId = workspaceId;
      }
    }

    return processed;
  }
  convertToSQLParameters(
    query: string,
    parameters?: Record<string, any>,
  ): { statement: string; parameters: ParameterInput[] } {
    const sqlParameters: ParameterInput[] = [];

    if (parameters) {
      // extract all params from the query
      const queryParamMatches = query.matchAll(/:([a-zA-Z_]\w*)/g);
      const queryParams = new Set(Array.from(queryParamMatches, (m) => m[1]));

      // only allow parameters that exist in the query
      for (const key of Object.keys(parameters)) {
        if (!queryParams.has(key)) {
          throw new Error(
            `Parameter "${key}" not found in query. Valid parameters: ${Array.from(queryParams).join(", ") || "none"}`,
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

  private _createParameter(key: string, value: any): ParameterInput | null {
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
          `Invalid aggregation level: ${value}. Must be one of: ${validLevels.join(", ")}`,
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
