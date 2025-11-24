import { executeStatementDefaults } from "./defaults";
import {
  Context,
  type WorkspaceClient,
  type sql,
} from "@databricks/sdk-experimental";

export interface SQLWarehouseConfig {
  timeout?: number;
}

export class SQLWarehouseConnector {
  private config: SQLWarehouseConfig;

  constructor(config: SQLWarehouseConfig) {
    this.config = config;
  }

  async executeStatement(
    workspaceClient: WorkspaceClient,
    input: sql.ExecuteStatementRequest,
    signal?: AbortSignal,
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

    const body: sql.ExecuteStatementRequest = {
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

    const response = await workspaceClient.statementExecution.executeStatement(
      body,
      this._createContext(signal),
    );
    const status = response.status;

    switch (status?.state) {
      case "RUNNING":
      case "PENDING":
        return await this._pollForStatementResult(
          workspaceClient,
          response.statement_id!,
          this.config.timeout,
          signal,
        );
      case "SUCCEEDED":
        return this._transformDataArray(response);
      case "FAILED":
        throw new Error(
          `Statement failed: ${status.error?.message || "Unknown error"}`,
        );
      case "CANCELED":
        throw new Error("Statement was canceled");
      case "CLOSED":
        throw new Error(
          "Statement execution completed but results are no longer available (CLOSED state)",
        );
      default:
        throw new Error(`Unknown statement state: ${status?.state}`);
    }
  }

  private async _pollForStatementResult(
    workspaceClient: WorkspaceClient,
    statementId: string,
    timeout = executeStatementDefaults.timeout,
    signal?: AbortSignal,
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

      const response = await workspaceClient.statementExecution.getStatement(
        {
          statement_id: statementId,
        },
        this._createContext(signal),
      );

      const status = response.status;

      switch (status?.state) {
        case "PENDING":
        case "RUNNING":
          // continue polling
          break;
        case "SUCCEEDED":
          return this._transformDataArray(response);
        case "FAILED":
          throw new Error(
            `Statement failed: ${status.error?.message || "Unknown error"}`,
          );
        case "CANCELED":
          throw new Error("Statement was canceled");
        case "CLOSED":
          throw new Error(
            "Statement execution completed but results are no longer available (CLOSED state)",
          );
        default:
          throw new Error(`Unknown statement state: ${status?.state}`);
      }

      // continue polling after delay
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, maxDelayBetweenPolls);
    }
  }

  private _transformDataArray(response: sql.StatementResponse) {
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

  // create context for cancellation token
  private _createContext(signal?: AbortSignal) {
    return new Context({
      cancellationToken: {
        isCancellationRequested: signal?.aborted ?? false,
        onCancellationRequested: (cb: () => void) => {
          signal?.addEventListener("abort", cb, { once: true });
        },
      },
    });
  }
}
