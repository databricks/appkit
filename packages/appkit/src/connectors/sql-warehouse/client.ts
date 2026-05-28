import {
  Context,
  type sql,
  type WorkspaceClient,
} from "@databricks/sdk-experimental";
import type { TelemetryOptions } from "shared";
import {
  AppKitError,
  ConnectionError,
  ExecutionError,
  ValidationError,
} from "../../errors";
import { createLogger } from "../../logging/logger";
import { ArrowStreamProcessor } from "../../stream/arrow-stream-processor";
import type { TelemetryProvider } from "../../telemetry";
import {
  type Counter,
  type Histogram,
  type Span,
  SpanKind,
  SpanStatusCode,
  TelemetryManager,
} from "../../telemetry";
import { executeStatementDefaults } from "./defaults";

const logger = createLogger("connectors:sql-warehouse");

interface SQLWarehouseConfig {
  timeout?: number;
  telemetry?: TelemetryOptions;
}

/**
 * Unified shape returned by {@link SQLWarehouseConnector.transformResult}.
 * Same top-level fields as {@link sql.StatementResponse}; `result.data` is
 * the name-keyed projection of `result.data_array` for JSON queries.
 * `result.external_links` is intentionally absent (pre-signed URLs that
 * must not flow downstream).
 */
type SQLTransformedResponse = Omit<sql.StatementResponse, "result"> & {
  result?: Omit<
    NonNullable<sql.StatementResponse["result"]>,
    "external_links"
  > & {
    data?: Record<string, unknown>[];
  };
};

export class SQLWarehouseConnector {
  private readonly name = "sql-warehouse";

  private config: SQLWarehouseConfig;

  private _arrowProcessor: ArrowStreamProcessor | null = null;
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
   * Submit a statement, poll if it hasn't reached a terminal state, and
   * transform the result. Callers that need to persist the warehouse-side
   * `statement_id` between submission and polling can compose
   * {@link submitStatement} + {@link pollStatement} directly.
   */
  async executeStatement(
    workspaceClient: WorkspaceClient,
    input: sql.ExecuteStatementRequest,
    signal?: AbortSignal,
  ) {
    const startTime = Date.now();
    let success = false;

    if (signal?.aborted) {
      throw ExecutionError.canceled();
    }

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
        let abortHandler: (() => void) | undefined;
        let isAborted = false;

        if (signal) {
          abortHandler = () => {
            if (!span.isRecording()) return;
            isAborted = true;
            span.setAttribute("cancelled", true);
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: "Query cancelled by client",
            });
            span.end();
          };
          signal.addEventListener("abort", abortHandler, { once: true });
        }

        try {
          span.addEvent("statement.submitting", {
            "db.warehouse_id": input.warehouse_id ?? "",
          });

          const response = await this.submitStatement(
            workspaceClient,
            input,
            signal,
          );
          const status = response.status;
          const statementId = response.statement_id as string;

          span.addEvent("statement.submitted", {
            "db.statement_id": statementId,
            "db.status": status?.state,
          });

          let result: SQLTransformedResponse;

          switch (status?.state) {
            case "RUNNING":
            case "PENDING":
              span.addEvent("statement.polling_started", {
                "db.status": status?.state,
              });
              result = await this.pollStatement(
                workspaceClient,
                statementId,
                signal,
              );
              break;
            case "SUCCEEDED":
              result = this.transformResult(response);
              break;
            case "FAILED":
              throw ExecutionError.statementFailed(status.error?.message);
            case "CANCELED":
              throw ExecutionError.canceled();
            case "CLOSED":
              throw ExecutionError.resultsClosed();
            default:
              throw ExecutionError.unknownState(
                String(status?.state ?? "unknown"),
              );
          }

          const rowCount = result.result?.data?.length ?? 0;
          if (rowCount > 0) {
            span.setAttribute("db.result.row_count", rowCount);
          }

          const duration = Date.now() - startTime;
          logger.event()?.setContext("sql-warehouse", {
            warehouse_id: input.warehouse_id,
            rows_returned: rowCount,
            query_duration_ms: duration,
          });

          success = true;
          if (!isAborted) {
            span.setStatus({ code: SpanStatusCode.OK });
          }
          return result;
        } catch (error) {
          if (!isAborted) {
            span.recordException(error as Error);
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: error instanceof Error ? error.message : String(error),
            });

            logger.error(
              "Statement execution failed: %s",
              error instanceof Error ? error.message : String(error),
            );
          }

          if (error instanceof AppKitError) {
            throw error;
          }
          throw ExecutionError.statementFailed(
            error instanceof Error ? error.message : String(error),
          );
        } finally {
          if (abortHandler && signal) {
            signal.removeEventListener("abort", abortHandler);
          }

          const duration = Date.now() - startTime;

          if (!isAborted) {
            span.end();
          }

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

  /**
   * Submit a statement and return the raw initial response. May already
   * be terminal if the warehouse completes within the request's
   * `wait_timeout`; otherwise the caller polls via {@link pollStatement}.
   */
  async submitStatement(
    workspaceClient: WorkspaceClient,
    input: sql.ExecuteStatementRequest,
    signal?: AbortSignal,
  ): Promise<sql.StatementResponse> {
    if (signal?.aborted) {
      throw ExecutionError.canceled();
    }
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
      wait_timeout: input.wait_timeout || executeStatementDefaults.wait_timeout,
      disposition: input.disposition || executeStatementDefaults.disposition,
      format: input.format || executeStatementDefaults.format,
      byte_limit: input.byte_limit,
      row_limit: input.row_limit,
      on_wait_timeout:
        input.on_wait_timeout || executeStatementDefaults.on_wait_timeout,
    };

    return this.telemetry.startActiveSpan(
      "sql.submit",
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "db.system": "databricks",
          "db.warehouse_id": body.warehouse_id || "",
          "db.catalog": body.catalog ?? "",
          "db.schema": body.schema ?? "",
          "db.statement": body.statement?.substring(0, 500) || "",
          "db.has_parameters": !!body.parameters,
        },
      },
      async (span: Span) => {
        try {
          const response =
            await workspaceClient.statementExecution.executeStatement(
              body,
              this._createContext(signal),
            );
          if (!response) {
            throw ConnectionError.apiFailure("SQL Warehouse");
          }
          if (response.statement_id) {
            span.setAttribute("db.statement_id", response.statement_id);
          }
          if (response.status?.state) {
            span.setAttribute("db.status", response.status.state);
          }
          span.setStatus({ code: SpanStatusCode.OK });
          return response;
        } catch (error) {
          // Client-initiated cancel isn't a span error.
          if (signal?.aborted) {
            span.setAttribute("cancelled", true);
            span.setStatus({ code: SpanStatusCode.OK });
          } else {
            span.recordException(error as Error);
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: error instanceof Error ? error.message : String(error),
            });
          }
          throw error;
        } finally {
          span.end();
        }
      },
      { name: this.name, includePrefix: true },
    );
  }

  /** Single non-blocking status read for a known statement ID. */
  async getStatement(
    workspaceClient: WorkspaceClient,
    statementId: string,
    signal?: AbortSignal,
  ): Promise<sql.StatementResponse> {
    if (signal?.aborted) {
      throw ExecutionError.canceled();
    }
    const response = await workspaceClient.statementExecution.getStatement(
      { statement_id: statementId },
      this._createContext(signal),
    );
    if (!response) {
      throw ConnectionError.apiFailure("SQL Warehouse");
    }
    return response;
  }

  /**
   * Block until the statement reaches a terminal state, then transform
   * via {@link transformResult}.
   */
  async pollStatement(
    workspaceClient: WorkspaceClient,
    statementId: string,
    signal?: AbortSignal,
    timeout = this.config.timeout ?? executeStatementDefaults.timeout,
  ): Promise<SQLTransformedResponse> {
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
          const maxDelayBetweenPolls = 5000;
          let pollCount = 0;

          while (true) {
            pollCount++;
            span.setAttribute("db.polling.current_attempt", pollCount);

            const elapsedTime = Date.now() - startTime;
            if (timeout > 0 && elapsedTime > timeout) {
              const error = ExecutionError.statementFailed(
                `Polling timeout exceeded after ${timeout}ms (elapsed: ${elapsedTime}ms)`,
              );
              span.recordException(error);
              span.setStatus({ code: SpanStatusCode.ERROR });
              throw error;
            }

            if (signal?.aborted) {
              throw ExecutionError.canceled();
            }

            span.addEvent("polling.attempt", {
              "poll.attempt": pollCount,
              "poll.delay_ms": delay,
              "poll.elapsed_ms": elapsedTime,
            });

            const response =
              await workspaceClient.statementExecution.getStatement(
                { statement_id: statementId },
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
                break;
              case "SUCCEEDED":
                span.setAttribute("db.polling.attempts", pollCount);
                span.setAttribute("db.polling.total_duration_ms", elapsedTime);
                span.addEvent("polling.completed", {
                  "poll.attempts": pollCount,
                  "poll.duration_ms": elapsedTime,
                });
                span.setStatus({ code: SpanStatusCode.OK });
                return this.transformResult(response);
              case "FAILED":
                throw ExecutionError.statementFailed(status.error?.message);
              case "CANCELED":
                throw ExecutionError.canceled();
              case "CLOSED":
                throw ExecutionError.resultsClosed();
              default:
                throw ExecutionError.unknownState(
                  String(status?.state ?? "unknown"),
                );
            }

            // ±25% jitter de-syncs concurrent pollers.
            const jitterMs = Math.floor(delay * (Math.random() - 0.5) * 0.5);
            const sleepMs = Math.max(0, delay + jitterMs);
            await new Promise<void>((resolve) => {
              if (sleepMs <= 0) {
                resolve();
                return;
              }
              const handle = setTimeout(() => {
                signal?.removeEventListener("abort", onAbort);
                resolve();
              }, sleepMs);
              const onAbort = () => {
                clearTimeout(handle);
                resolve();
              };
              signal?.addEventListener("abort", onAbort, { once: true });
            });
            if (signal?.aborted) {
              throw ExecutionError.canceled();
            }
            delay = Math.min(delay * 2, maxDelayBetweenPolls);
          }
        } catch (error) {
          // Logging is handled by the caller.
          if (signal?.aborted) {
            span.setAttribute("cancelled", true);
            span.setStatus({ code: SpanStatusCode.OK });
          } else {
            span.recordException(error as Error);
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: error instanceof Error ? error.message : String(error),
            });
          }
          if (error instanceof AppKitError) {
            throw error;
          }
          throw ExecutionError.statementFailed(
            error instanceof Error ? error.message : String(error),
          );
        } finally {
          span.end();
        }
      },
      { name: this.name, includePrefix: true },
    );
  }

  /**
   * Standard result transform. Returns the same shape in every branch
   * (see {@link SQLTransformedResponse}):
   * - ARROW_STREAM: top-level `statement_id`/`status` preserved; `manifest`
   *   and `result.external_links` stripped (pre-signed URLs must not flow
   *   downstream). Consumer fetches the Arrow buffer via
   *   {@link getArrowData}.
   * - JSON with rows + schema: positional `result.data_array` projected
   *   into name-keyed `result.data` (JSON-looking STRING values parsed).
   * - Otherwise: pass-through.
   */
  transformResult(response: sql.StatementResponse): SQLTransformedResponse {
    if (response.manifest?.format === "ARROW_STREAM") {
      return {
        ...response,
        manifest: undefined,
        result: {
          statement_id: response.statement_id,
          status: response.status,
        } as SQLTransformedResponse["result"],
      };
    }

    if (!response.result?.data_array || !response.manifest?.schema?.columns) {
      return response as SQLTransformedResponse;
    }

    const columns = response.manifest.schema.columns;
    const transformedData = response.result.data_array.map((row) => {
      const obj: Record<string, unknown> = {};
      row.forEach((value, index) => {
        const column = columns[index];
        const columnName = column?.name || `column_${index}`;

        if (
          column?.type_name === "STRING" &&
          typeof value === "string" &&
          value &&
          (value[0] === "{" || value[0] === "[")
        ) {
          try {
            obj[columnName] = JSON.parse(value);
          } catch {
            obj[columnName] = value;
          }
        } else {
          obj[columnName] = value;
        }
      });
      return obj;
    });

    const { data_array: _data_array, ...restResult } = response.result;
    return {
      ...response,
      result: {
        ...restResult,
        data: transformedData,
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

          logger.event()?.setContext("sql-warehouse", {
            arrow_data_size_bytes: result.data.length,
            arrow_job_id: jobId,
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

          logger.error("Failed Arrow job: %s %O", jobId, error);

          if (error instanceof AppKitError) {
            throw error;
          }
          throw ExecutionError.statementFailed(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    );
  }

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
