import type { IAuthManager } from "@databricks-apps/types";
import { executeStatementDefaults } from "./defaults";
import type {
  ExecuteStatementRequest,
  ExecuteStatementResponse,
} from "./types";

export interface SQLWarehouseConfig {
  host: string;
  auth: IAuthManager;
  timeout?: number;
}

export class SQLWarehouseConnector {
  private config: SQLWarehouseConfig;

  constructor(config: SQLWarehouseConfig) {
    this.config = config;
  }

  async executeStatement(
    input: ExecuteStatementRequest,
    signal?: AbortSignal,
    authOptions?: { userToken?: string },
  ) {
    // validate required fields
    if (!input.statement) {
      throw new Error(
        "Statement is required: Please provide a SQL statement to execute",
      );
    }

    if (!input.warehouse_id) {
      throw new Error(
        "Warehouse ID is required: Please provide a warehouse_id to execute the statement",
      );
    }

    const body: ExecuteStatementRequest = {
      statement: input.statement,
      parameters: input.parameters,
      warehouse_id: input.warehouse_id,
      catalog: input.catalog,
      schema: input.schema,
      wait_timeout: input.wait_timeout || executeStatementDefaults.wait_timeout,
      disposition: input.disposition || executeStatementDefaults.disposition,
      format: input.format || executeStatementDefaults.format,
      byte_limit: input.byte_limit,
      row_limit: input.row_limit,
      on_wait_timeout:
        input.on_wait_timeout || executeStatementDefaults.on_wait_timeout,
    };

    const endpoint = "/api/2.0/sql/statements/";
    const response = await this._makeRequest<ExecuteStatementResponse>(
      endpoint,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
      signal,
      authOptions,
    );

    if (!response) {
      throw new Error("No response received from SQL Warehouse API");
    }

    switch (response.status.state) {
      case "RUNNING":
      case "PENDING":
        return await this._pollForStatementResult(
          response.statement_id,
          this.config.timeout,
          signal,
          authOptions,
        );
      case "SUCCEEDED":
        return this._transformDataArray(response);
      case "FAILED":
        throw new Error(
          `Statement failed: ${response.status.error?.message || "Unknown error"}`,
        );
      case "CANCELED":
        throw new Error("Statement was canceled");
      case "CLOSED":
        throw new Error(
          "Statement execution completed but results are no longer available (CLOSED state)",
        );
      default:
        throw new Error(`Unknown statement state: ${response.status.state}`);
    }
  }

  private async _makeRequest<T>(
    endpoint: string,
    options: {
      method: "GET" | "POST" | "DELETE";
      body?: string;
    },
    signal?: AbortSignal,
    authOptions?: { userToken?: string },
  ): Promise<T> {
    const token = authOptions?.userToken
      ? authOptions.userToken
      : await this.config.auth.getAuthToken();

    if (!token) {
      throw new Error("No authentication token provided for SQL Warehouse API");
    }

    if (!this.config.host) {
      throw new Error(
        "No host configured: Please provide a host in SQLWarehouseConfig",
      );
    }

    const url = `https://${this.config.host}${endpoint}`;
    const response = await fetch(url, {
      method: options.method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-type": "application/json",
      },
      body: options.body,
      signal,
    });

    if (!response.ok) {
      throw new Error(
        `SQL Warehouse API error: ${response.status} ${response.statusText}`,
      );
    }

    if (response.status === 204 || options.method === "DELETE") {
      throw new Error("No content returned from SQL Warehouse API");
    }

    const responseData = (await response.json()) as T;
    return responseData;
  }

  private async _pollForStatementResult(
    statementId: string,
    timeout = executeStatementDefaults.timeout,
    signal?: AbortSignal,
    authOptions?: { userToken?: string },
  ) {
    const startTime = Date.now();
    let delay = 1000;
    const maxDelayBetweenPolls = 5000; // max 5 seconds between polls

    while (true) {
      // check if timeout exceeded
      const elapsedTime = Date.now() - startTime;
      if (elapsedTime > timeout) {
        throw new Error(
          `Statement polling timeout exceeded after ${timeout}ms (elapsed: ${elapsedTime}ms)`,
        );
      }

      if (signal?.aborted) {
        throw new Error("Request aborted");
      }

      const endpoint = `/api/2.0/sql/statements/${statementId}`;
      const response = await this._makeRequest<ExecuteStatementResponse>(
        endpoint,
        { method: "GET" },
        signal,
        authOptions,
      );

      if (!response) {
        throw new Error("No response received from SQL Warehouse API");
      }

      switch (response.status.state) {
        case "PENDING":
        case "RUNNING":
          // continue polling
          break;
        case "SUCCEEDED":
          return this._transformDataArray(response);
        case "FAILED":
          throw new Error(
            `Statement failed: ${response.status.error?.message || "Unknown error"}`,
          );
        case "CANCELED":
          throw new Error("Statement was canceled");
        case "CLOSED":
          throw new Error(
            "Statement execution completed but results are no longer available (CLOSED state)",
          );
        default:
          throw new Error(`Unknown statement state: ${response.status.state}`);
      }

      // continue polling after delay
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, maxDelayBetweenPolls);
    }
  }

  private _transformDataArray(response: ExecuteStatementResponse) {
    if (!response.result?.data_array || !response.manifest?.schema?.columns) {
      return response;
    }

    const columns = response.manifest.schema.columns;

    const transformedData = response.result.data_array.map((row) => {
      const obj: Record<string, unknown> = {};
      row.forEach((value, index) => {
        const column = columns[index];
        const columnName = column?.name || `column_${index}`;

        // attempt to parse JSON strings for string columns
        if (
          column?.type_name === "STRING" &&
          typeof value === "string" &&
          value &&
          (value[0] === "{" || value[0] === "[")
        ) {
          try {
            obj[columnName] = JSON.parse(value);
          } catch {
            // if parsing fails, keep as string
            obj[columnName] = value;
          }
        } else {
          obj[columnName] = value;
        }
      });
      return obj;
    });

    // remove data_array
    const { data_array: _data_array, ...restResult } = response.result;
    return {
      ...response,
      result: {
        ...restResult,
        data: transformedData,
      },
    };
  }
}
