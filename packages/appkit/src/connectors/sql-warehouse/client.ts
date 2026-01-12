import {
  Context,
  type sql,
  type WorkspaceClient,
} from "@databricks/sdk-experimental";
import {
  type Counter,
  type Histogram,
  type ILogger,
  LoggerManager,
  type ObservabilityOptions,
  type Span,
  SpanStatusCode,
} from "@/observability";
import { ArrowStreamProcessor } from "../../stream/arrow-stream-processor";
import { executeStatementDefaults } from "./defaults";

export interface SQLWarehouseConfig {
  timeout?: number;
  observability?: ObservabilityOptions;
}

export class SQLWarehouseConnector {
  private readonly name = "sql-warehouse";

  private config: SQLWarehouseConfig;

  // Lazy-initialized: only created when Arrow format is used
  private _arrowProcessor: ArrowStreamProcessor | null = null;

  private readonly logger: ILogger;
  private readonly metrics: {
    queryCount: Counter;
    queryDuration: Histogram;
  };

  constructor(config: SQLWarehouseConfig) {
    this.config = config;

    this.logger = LoggerManager.getLogger(
      this.name,
      this.config?.observability,
    );
    this.metrics = {
      queryCount: this.logger.counter("query.count", {
        description: "Total number of queries executed",
        unit: "1",
      }),
      queryDuration: this.logger.histogram("query.duration", {
        description: "Duration of queries executed",
        unit: "ms",
      }),
    };

    this.logger.debug("SQLWarehouseConnector initialized", { config });
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

    this.logger.info("Executing statement", {
      warehouse_id: input.warehouse_id,
      catalog: input.catalog,
      schema: input.schema,
      has_parameters: !!input.parameters,
    });

    return this.logger.span("query", async (span: Span) => {
      span.setAttribute("db.system", "databricks");
      span.setAttribute("db.warehouse_id", input.warehouse_id || "");
      span.setAttribute("db.catalog", input.catalog ?? "");
      span.setAttribute("db.schema", input.schema ?? "");
      span.setAttribute("db.statement_length", input.statement?.length || 0);
      span.setAttribute("db.has_parameters", !!input.parameters);
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

        this.logger.debug("Submitting statement to warehouse");

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

        this.logger.debug("Statement submitted", {
          statement_id: response.statement_id,
          status: status?.state,
        });

        let result:
          | sql.StatementResponse
          | { result: { statement_id: string; status: sql.StatementStatus } };

        switch (status?.state) {
          case "RUNNING":
          case "PENDING":
            this.logger.debug("Statement polling started", {
              statement_id: response.statement_id,
              status: status?.state,
            });
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
        const rowCount =
          resultData?.data?.length || resultData?.data_array?.length;

        if (rowCount > 0) {
          span.setAttribute("db.result.row_count", rowCount);
        }

        const duration = Date.now() - startTime;

        success = true;
        span.setStatus({ code: SpanStatusCode.OK });

        // Context flows automatically to: Terminal + WideEvent.context + Span events
        this.logger.info("Query completed", {
          statement_id: response.statement_id,
          rows_returned: rowCount,
          query_duration_ms: duration,
        });

        return result;
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });

        this.logger.error("Query failed", error as Error, {
          warehouse_id: input.warehouse_id,
        });
        throw error;
      } finally {
        const duration = Date.now() - startTime;

        const attributes = {
          "db.warehouse_id": input.warehouse_id,
          "db.catalog": input.catalog ?? "",
          "db.schema": input.schema ?? "",
          success: success.toString(),
        };

        this.metrics.queryCount.add(1, attributes);
        this.metrics.queryDuration.record(duration, attributes);
      }
    });
  }

  private async _pollForStatementResult(
    workspaceClient: WorkspaceClient,
    statementId: string,
    timeout = executeStatementDefaults.timeout,
    signal?: AbortSignal,
  ) {
    return this.logger.span("poll", async (span: Span) => {
      span.setAttribute("db.statement_id", statementId);
      span.setAttribute("db.polling.timeout", timeout);
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
    });
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

    return this.logger.span("arrow.getData", async (span: Span) => {
      span.setAttribute("db.system", "databricks");
      span.setAttribute("arrow.job_id", jobId);
      try {
        const response = await workspaceClient.statementExecution.getStatement(
          { statement_id: jobId },
          this._createContext(signal),
        );

        const chunks = response.result?.external_links;
        const schema = response.manifest?.schema;

        if (!chunks || !schema) {
          throw new Error("No chunks or schema found in response");
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
        this.metrics.queryDuration.record(duration, {
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
        this.metrics.queryDuration.record(duration, {
          operation: "arrow.getData",
          status: "error",
        });

        console.error(`Failed Arrow job: ${jobId}`, error);
        throw error;
      }
    });
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
