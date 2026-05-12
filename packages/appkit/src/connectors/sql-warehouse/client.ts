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
import { buildEmptyArrowIPCBase64 } from "./arrow-schema";
import { executeStatementDefaults } from "./defaults";

const logger = createLogger("connectors:sql-warehouse");

/**
 * Maximum size for inline Arrow IPC attachments (8 MiB decoded).
 * Aligned with `streamDefaults.maxEventSize` so anything that would exceed
 * the SSE event cap fails here with a clear error rather than a confusing
 * "Buffer size exceeded" downstream. Larger results should use
 * `disposition: "EXTERNAL_LINKS"`, which the analytics fallback handles.
 *
 * RAISE TO 25 MiB (Databricks API hard cap on INLINE) if PR #320 (stash +
 * serve via /arrow-result) lands — that proposal moves bulk bytes off SSE
 * onto HTTP, so the SSE event-size constraint no longer applies here.
 */
const MAX_INLINE_ATTACHMENT_BYTES = 8 * 1024 * 1024;

interface SQLWarehouseConfig {
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

    // if signal is aborted, throw an error
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
            // abort span if not recording
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
              throw ExecutionError.statementFailed(
                status.error?.message,
                status.error?.error_code,
              );
            case "CANCELED":
              throw ExecutionError.canceled();
            case "CLOSED":
              throw ExecutionError.resultsClosed();
            default:
              throw ExecutionError.unknownState(
                String(status?.state ?? "unknown"),
              );
          }

          const resultData = result.result as any;
          const rowCount =
            resultData?.data?.length ?? resultData?.data_array?.length ?? 0;

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
          // only set success status if not aborted
          if (!isAborted) {
            span.setStatus({ code: SpanStatusCode.OK });
          }
          return result;
        } catch (error) {
          // only record error if not already handled by abort
          if (!isAborted) {
            span.recordException(error as Error);
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: error instanceof Error ? error.message : String(error),
            });
          }

          if (error instanceof AppKitError) {
            throw error;
          }
          // Preserve the SDK's structured ApiError.errorCode (e.g.
          // "INVALID_PARAMETER_VALUE", "BAD_REQUEST") through the wrap so
          // callers can branch on a stable identifier rather than
          // substring-matching the message.
          const sdkErrorCode =
            error && typeof error === "object" && "errorCode" in error
              ? (error as { errorCode?: unknown }).errorCode
              : undefined;
          throw ExecutionError.statementFailed(
            error instanceof Error ? error.message : String(error),
            typeof sdkErrorCode === "string" ? sdkErrorCode : undefined,
          );
        } finally {
          // remove abort handler
          if (abortHandler && signal) {
            signal.removeEventListener("abort", abortHandler);
          }

          const duration = Date.now() - startTime;

          // end span if not already ended by abort handler
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
              const error = ExecutionError.statementFailed(
                `Polling timeout exceeded after ${timeout}ms (elapsed: ${elapsedTime}ms)`,
              );
              span.recordException(error);
              span.setStatus({ code: SpanStatusCode.ERROR });
              throw error;
            }

            if (signal?.aborted) {
              const error = ExecutionError.canceled();
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
                throw ExecutionError.statementFailed(
                  status.error?.message,
                  status.error?.error_code,
                );
              case "CANCELED":
                throw ExecutionError.canceled();
              case "CLOSED":
                throw ExecutionError.resultsClosed();
              default:
                throw ExecutionError.unknownState(
                  String(status?.state ?? "unknown"),
                );
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

          if (error instanceof AppKitError) {
            throw error;
          }
          const sdkErrorCode =
            error && typeof error === "object" && "errorCode" in error
              ? (error as { errorCode?: unknown }).errorCode
              : undefined;
          throw ExecutionError.statementFailed(
            error instanceof Error ? error.message : String(error),
            typeof sdkErrorCode === "string" ? sdkErrorCode : undefined,
          );
        } finally {
          span.end();
        }
      },
      { name: this.name, includePrefix: true },
    );
  }

  private _transformDataArray(response: sql.StatementResponse) {
    if (response.manifest?.format === "ARROW_STREAM") {
      const result = response.result as
        | (sql.ResultData & { attachment?: string })
        | undefined;

      // Inline Arrow: pass the base64 IPC attachment through unmodified so
      // the analytics route can stream it to the client, where the existing
      // ArrowClient infrastructure decodes it into a Table. Validate size
      // here to fail fast on runaway payloads.
      if (result?.attachment) {
        return this._validateArrowAttachment(response, result.attachment);
      }

      // External links: data fetched separately via statement_id.
      if (result?.external_links) {
        return this.updateWithArrowStatus(response);
      }

      // Empty result with a known schema: synthesize a zero-row Arrow IPC
      // attachment so the client always receives an Arrow Table for
      // ARROW_STREAM, regardless of whether the warehouse returned data.
      // Note: an empty array (`data_array: []`) is truthy, so length-check
      // explicitly — otherwise zero-row responses fall through to the JSON
      // row transform below and return `[]` JSON rows instead of an Arrow
      // table.
      const hasNoRows =
        !result?.data_array ||
        (Array.isArray(result.data_array) && result.data_array.length === 0);
      if (hasNoRows && response.manifest?.schema?.columns) {
        const synthesized = buildEmptyArrowIPCBase64(
          response.manifest.schema.columns,
        );
        return {
          ...response,
          result: { ...(result ?? {}), attachment: synthesized },
        };
      }

      // Inline data_array under ARROW_STREAM (rare): fall through to the
      // row transform below. The hook will receive `type: "result"` rows;
      // callers asking for ARROW_STREAM should not hit this path with
      // current Databricks warehouses.
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

  /**
   * Validate (but do not decode) a base64 Arrow IPC attachment.
   * Some serverless warehouses return inline results as Arrow IPC in
   * `result.attachment`. We pass the base64 string through to the client,
   * which decodes it into an Arrow Table via the existing ArrowClient
   * infrastructure. This keeps the wire contract for ARROW_STREAM
   * consistent (client always receives an Arrow Table) and avoids
   * decode/re-encode work on the server.
   */
  private _validateArrowAttachment(
    response: sql.StatementResponse,
    attachment: string,
  ) {
    // Cap the size to protect against unbounded inline payloads from
    // misbehaving warehouses. 64 MiB is well above the typical inline limit
    // (~25 MiB hard cap on the API) but bounds memory if a server returns
    // a runaway response.
    //
    // Strip whitespace (rare but legal in base64) and account for trailing
    // `=` padding so the byte count is exact rather than an upper bound.
    const stripped = attachment.replace(/\s+/g, "");
    const padding = stripped.endsWith("==")
      ? 2
      : stripped.endsWith("=")
        ? 1
        : 0;
    const decodedSize = Math.floor((stripped.length * 3) / 4) - padding;
    if (decodedSize > MAX_INLINE_ATTACHMENT_BYTES) {
      throw ExecutionError.statementFailed(
        `Inline Arrow attachment exceeds maximum size (${decodedSize} > ${MAX_INLINE_ATTACHMENT_BYTES} bytes)`,
      );
    }
    return response;
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
