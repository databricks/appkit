import {
  Context,
  type sql,
  type WorkspaceClient,
} from "@databricks/sdk-experimental";
import { ArrowStreamProcessor } from "../../stream/arrow-stream-processor";
import type { TelemetryOptions } from "shared";
import type { TelemetryProvider } from "../../telemetry";
import {
  type Counter,
  type Histogram,
  type Span,
  SpanKind,
  SpanStatusCode,
  TelemetryManager,
} from "../../telemetry";
import {
  ConnectionError,
  ExecutionError,
  ValidationError,
} from "../../observability/errors";
import { executeStatementDefaults } from "./defaults";

export interface SQLWarehouseConfig {
  timeout?: number;
  telemetry?: TelemetryOptions;
}

export class SQLWarehouseConnector {
  private readonly name = "sql-warehouse";

  private config: SQLWarehouseConfig;

  // Lazy-initialized: only created when Arrow format is used
  private _arrowProcessor: ArrowStreamProcessor | null = null;
  // telemetry
  private readonly telemetry: TelemetryProvider;
  private readonly telemetryMetrics: {
    queryCount: Counter;
    queryDuration: Histogram;
  };

  constructor(config: SQLWarehouseConfig) {
    this.config = config;

    this.telemetry = TelemetryManager.getProvider(
      this.name,
      this.config.telemetry,
    );
    this.telemetryMetrics = {
      queryCount: this.telemetry.getMeter().createCounter("query.count", {
        description: "Total number of queries executed",
        unit: "1",
      }),
      queryDuration: this.telemetry
        .getMeter()
        .createHistogram("query.duration", {
          description: "Duration of queries executed",
          unit: "ms",
        }),
    };
  }

  /**
   * Lazily initializes and returns the ArrowStreamProcessor.
   * Only created on first Arrow format query to avoid unnecessary allocation.
   */
  private get arrowProcessor(): ArrowStreamProcessor {
    if (!this._arrowProcessor) {
      this._arrowProcessor = new ArrowStreamProcessor({
        timeout: this.config.timeout || executeStatementDefaults.timeout,
        maxConcurrentDownloads:
          ArrowStreamProcessor.DEFAULT_MAX_CONCURRENT_DOWNLOADS,
        retries: ArrowStreamProcessor.DEFAULT_RETRIES,
      });
    }
    return this._arrowProcessor;
  }

  async executeStatement(
    workspaceClient: WorkspaceClient,
    input: sql.ExecuteStatementRequest,
    signal?: AbortSignal,
  ) {
    const startTime = Date.now();
    let success = false;

    return this.telemetry.startActiveSpan(
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
            throw ValidationError.missingField("statement");
          }

          if (!input.warehouse_id) {
            throw ValidationError.missingField("warehouse_id");
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
            throw ConnectionError.apiFailure("SQL Warehouse");
          }
          const status = response.status;
          const statementId = response.statement_id as string;

          span.setAttribute("db.statement_id", statementId);
          span.addEvent("statement.submitted", {
            "db.statement_id": response.statement_id,
            "db.status": status?.state,
          });

          let result:
            | sql.StatementResponse
            | { result: { statement_id: string; status: sql.StatementStatus } };

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
              throw ExecutionError.statementFailed(status.error?.message);
            case "CANCELED":
              throw ExecutionError.canceled();
            case "CLOSED":
              throw ExecutionError.resultsClosed();
            default:
              throw ExecutionError.unknownState(status?.state as string);
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

          this.telemetryMetrics.queryCount.add(1, attributes);
          this.telemetryMetrics.queryDuration.record(duration, attributes);
        }
      },
      { name: this.name, includePrefix: true },
    );
  }

  private async _pollForStatementResult(
    workspaceClient: WorkspaceClient,
    statementId: string,
    timeout = executeStatementDefaults.timeout,
    signal?: AbortSignal,
  ) {
    return this.telemetry.startActiveSpan(
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
              throw ConnectionError.apiFailure("SQL Warehouse");
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
                throw ExecutionError.statementFailed(status.error?.message);
              case "CANCELED":
                throw ExecutionError.canceled();
              case "CLOSED":
                throw ExecutionError.resultsClosed();
              default:
                throw ExecutionError.unknownState(status?.state as string);
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
      { name: this.name, includePrefix: true },
    );
  }

  private _transformDataArray(response: sql.StatementResponse) {
    if (response.manifest?.format === "ARROW_STREAM") {
      return this.updateWithArrowStatus(response);
    }

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

  private updateWithArrowStatus(response: sql.StatementResponse): {
    result: { statement_id: string; status: sql.StatementStatus };
  } {
    return {
      result: {
        statement_id: response.statement_id as string,
        status: {
          state: response.status?.state,
          error: response.status?.error,
        } as sql.StatementStatus,
      },
    };
  }

  async getArrowData(
    workspaceClient: WorkspaceClient,
    jobId: string,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof this.arrowProcessor.processChunks>> {
    const startTime = Date.now();

    return this.telemetry.startActiveSpan(
      "arrow.getData",
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "db.system": "databricks",
          "arrow.job_id": jobId,
        },
      },
      async (span: Span) => {
        try {
          const response =
            await workspaceClient.statementExecution.getStatement(
              { statement_id: jobId },
              this._createContext(signal),
            );

          const chunks = response.result?.external_links;
          const schema = response.manifest?.schema;

          if (!chunks || !schema) {
            throw ExecutionError.missingData("chunks or schema");
          }

          span.setAttribute("arrow.chunk_count", chunks.length);

          const result = await this.arrowProcessor.processChunks(
            chunks,
            schema,
            signal,
          );

          span.setAttribute("arrow.data_size_bytes", result.data.length);
          span.setStatus({ code: SpanStatusCode.OK });

          const duration = Date.now() - startTime;
          this.telemetryMetrics.queryDuration.record(duration, {
            operation: "arrow.getData",
            status: "success",
          });

          return result;
        } catch (error) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : "Unknown error",
          });
          span.recordException(error as Error);

          const duration = Date.now() - startTime;
          this.telemetryMetrics.queryDuration.record(duration, {
            operation: "arrow.getData",
            status: "error",
          });

          console.error(`Failed Arrow job: ${jobId}`, error);
          throw error;
        }
      },
    );
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
