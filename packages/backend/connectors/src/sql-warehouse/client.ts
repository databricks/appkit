import {
  Context,
  type sql,
  type WorkspaceClient,
} from "@databricks/sdk-experimental";
import type { ITelemetry } from "@databricks-apps/telemetry";
import {
  type Counter,
  type Histogram,
  type Meter,
  type Span,
  SpanKind,
  SpanStatusCode,
} from "@databricks-apps/telemetry";
import { executeStatementDefaults } from "./defaults";

export interface SQLWarehouseConfig {
  timeout?: number;
  telemetry: ITelemetry;
}

export class SQLWarehouseConnector {
  private static readonly TELEMETRY_INSTRUMENT_CONFIG = {
    name: "sql-warehouse",
    includePrefix: true,
  };

  private config: SQLWarehouseConfig;

  private meter: Meter;
  private queryCounter: Counter;
  private queryDuration: Histogram;

  constructor(config: SQLWarehouseConfig) {
    this.config = config;
    this.meter = this.config.telemetry.getMeter(
      SQLWarehouseConnector.TELEMETRY_INSTRUMENT_CONFIG,
    );

    this.queryCounter = this.meter.createCounter("db.query.count", {
      description: "Total number of database queries",
      unit: "1",
    });
    this.queryDuration = this.meter.createHistogram("db.query.duration", {
      description: "Duration of database queries",
      unit: "ms",
    });
  }

  async executeStatement(
    workspaceClient: WorkspaceClient,
    input: sql.ExecuteStatementRequest,
    signal?: AbortSignal,
  ) {
    const startTime = Date.now();
    let success = false;

    return this.config.telemetry.startActiveSpan(
      "sql.query",
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "db.system": "databricks",
          "db.warehouse_id": input.warehouse_id || "",
          "db.catalog": input.catalog ?? "",
          "db.schema": input.schema ?? "",
          "db.statement": input.statement?.substring(0, 500) || "",
          "db.has_parameters": !!input.parameters,
        },
      },
      async (span: Span) => {
        try {
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
            wait_timeout:
              input.wait_timeout || executeStatementDefaults.wait_timeout,
            disposition:
              input.disposition || executeStatementDefaults.disposition,
            format: input.format || executeStatementDefaults.format,
            byte_limit: input.byte_limit,
            row_limit: input.row_limit,
            on_wait_timeout:
              input.on_wait_timeout || executeStatementDefaults.on_wait_timeout,
          };

          span.addEvent("statement.submitting", {
            "db.warehouse_id": input.warehouse_id,
          });

          const response =
            await workspaceClient.statementExecution.executeStatement(
              body,
              this._createContext(signal),
            );

          if (!response) {
            throw new Error("No response received from SQL Warehouse API");
          }
          const status = response.status;
          const statementId = response.statement_id as string;

          span.setAttribute("db.statement_id", statementId);
          span.addEvent("statement.submitted", {
            "db.statement_id": response.statement_id,
            "db.status": status?.state,
          });

          let result: sql.StatementResponse;
          switch (status?.state) {
            case "RUNNING":
            case "PENDING":
              span.addEvent("statement.polling_started", {
                "db.status": response.status?.state,
              });
              result = await this._pollForStatementResult(
                workspaceClient,
                statementId,
                this.config.timeout,
                signal,
              );
              break;
            case "SUCCEEDED":
              result = this._transformDataArray(response);
              break;
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

          const resultData = result.result as any;
          if (resultData?.data) {
            span.setAttribute("db.result.row_count", resultData.data.length);
          } else if (resultData?.data_array) {
            span.setAttribute(
              "db.result.row_count",
              resultData.data_array.length,
            );
          }

          success = true;
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : String(error),
          });
          throw error;
        } finally {
          const duration = Date.now() - startTime;
          span.end();

          const attributes = {
            "db.warehouse_id": input.warehouse_id,
            "db.catalog": input.catalog ?? "",
            "db.schema": input.schema ?? "",
            "db.statement": input.statement?.substring(0, 500) || "",
            success: success.toString(),
          };

          this.queryCounter.add(1, attributes);
          this.queryDuration.record(duration, attributes);
        }
      },
      SQLWarehouseConnector.TELEMETRY_INSTRUMENT_CONFIG,
    );
  }

  private async _pollForStatementResult(
    workspaceClient: WorkspaceClient,
    statementId: string,
    timeout = executeStatementDefaults.timeout,
    signal?: AbortSignal,
  ) {
    return this.config.telemetry.startActiveSpan(
      "sql.poll",
      {
        attributes: {
          "db.statement_id": statementId,
          "db.polling.timeout": timeout,
        },
      },
      async (span: Span) => {
        try {
          const startTime = Date.now();
          let delay = 1000;
          const maxDelayBetweenPolls = 5000; // max 5 seconds between polls
          let pollCount = 0;

          while (true) {
            pollCount++;
            span.setAttribute("db.polling.current_attempt", pollCount);

            // check if timeout exceeded
            const elapsedTime = Date.now() - startTime;
            if (elapsedTime > timeout) {
              const error = new Error(
                `Statement polling timeout exceeded after ${timeout}ms (elapsed: ${elapsedTime}ms)`,
              );
              span.recordException(error);
              span.setStatus({ code: SpanStatusCode.ERROR });
              throw error;
            }

            if (signal?.aborted) {
              const error = new Error("Request aborted");
              span.recordException(error);
              span.setStatus({ code: SpanStatusCode.ERROR });
              throw error;
            }

            span.addEvent("polling.attempt", {
              "poll.attempt": pollCount,
              "poll.delay_ms": delay,
              "poll.elapsed_ms": elapsedTime,
            });

            const response =
              await workspaceClient.statementExecution.getStatement(
                {
                  statement_id: statementId,
                },
                this._createContext(signal),
              );
            if (!response) {
              throw new Error("No response received from SQL Warehouse API");
            }

            const status = response.status;

            span.addEvent("polling.status_check", {
              "db.status": status?.state,
              "poll.attempt": pollCount,
            });

            switch (status?.state) {
              case "PENDING":
              case "RUNNING":
                // continue polling
                break;
              case "SUCCEEDED":
                span.setAttribute("db.polling.attempts", pollCount);
                span.setAttribute("db.polling.total_duration_ms", elapsedTime);
                span.addEvent("polling.completed", {
                  "poll.attempts": pollCount,
                  "poll.duration_ms": elapsedTime,
                });
                span.setStatus({ code: SpanStatusCode.OK });
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
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : String(error),
          });
          throw error;
        } finally {
          span.end();
        }
      },
      SQLWarehouseConnector.TELEMETRY_INSTRUMENT_CONFIG,
    );
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
