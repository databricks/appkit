import { createHash } from "node:crypto";
import type { sql } from "@databricks/sdk-experimental";
import {
  isSQLTypeMarker,
  type SQLTypeMarker,
  sql as sqlHelpers,
} from "../sql/helpers";
import { getRequestContext } from "../utils";

type SQLParameterValue = SQLTypeMarker | null | undefined;

export class QueryProcessor {
  async processQueryParams(
    query: string,
    parameters?: Record<string, SQLParameterValue>,
  ): Promise<Record<string, SQLParameterValue>> {
    const processed = { ...parameters };

    // extract all params from the query
    const paramMatches = query.matchAll(/:([a-zA-Z_]\w*)/g);
    const queryParams = new Set(Array.from(paramMatches, (m) => m[1]));

    // auto-inject workspaceId if needed and not provided
    if (queryParams.has("workspaceId") && !processed.workspaceId) {
      const requestContext = getRequestContext();
      const workspaceId = await requestContext.workspaceId;
      if (workspaceId) {
        processed.workspaceId = sqlHelpers.string(workspaceId);
      }
    }

    return processed;
  }

  hashQuery(query: string): string {
    return createHash("md5").update(query).digest("hex");
  }

  convertToSQLParameters(
    query: string,
    parameters?: Record<string, SQLParameterValue>,
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
    value: SQLParameterValue,
  ): sql.StatementParameterListItem | null {
    if (value === null || value === undefined) {
      return null;
    }

    if (!isSQLTypeMarker(value)) {
      throw new Error(
        `Parameter "${key}" must be a SQL type. Use sql.string(), sql.number(), sql.date(), sql.timestamp(), or sql.boolean().`,
      );
    }

    return {
      name: key,
      value: value.value,
      type: value.__sql_type,
    };
  }
}
