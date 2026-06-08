import {
  Context,
  type sql,
  type WorkspaceClient,
} from "@databricks/sdk-experimental";
import type { TelemetryOptions } from "shared";
import {
  AppKitError,
  ConfigurationError,
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
import { WarehousePollBackoff } from "./warehouse-poll-backoff";
import { WarehouseStatusEmitter } from "./warehouse-status-emitter";

const logger = createLogger("connectors:sql-warehouse");

interface SQLWarehouseConfig {
  timeout?: number;
  telemetry?: TelemetryOptions;
}

/**
 * Default ceiling for how long {@link SQLWarehouseConnector.ensureWarehouseRunning}
 * will wait for a warehouse to reach the RUNNING state before giving up.
 *
 * Five minutes covers a cold-start of a classic warehouse on most workspaces;
 * serverless typically reaches RUNNING within ~30s.
 */
export const DEFAULT_WAREHOUSE_STARTUP_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Window during which a recent `RUNNING` observation lets subsequent calls
 * to {@link SQLWarehouseConnector.ensureWarehouseRunning} short-circuit
 * without making any SDK calls. Sized to roughly the upper bound of how
 * long Databricks keeps a warehouse "stickily" available between requests
 * — past that, we re-verify.
 */
const WAREHOUSE_RUNNING_CACHE_TTL_MS = 30_000;

/**
 * A single observation of the warehouse state, emitted by
 * {@link SQLWarehouseConnector.ensureWarehouseRunning} so callers can stream
 * progress to clients (e.g. over SSE).
 *
 * Note: `health.summary` from the SDK is intentionally NOT exposed on this
 * type. It's free-form operator-oriented diagnostic text (cluster IDs,
 * capacity-failure reasons, internal RPC errors) that must not reach end
 * users. The raw value stays in the OTel span attributes for server-side
 * debugging only.
 */
export interface WarehouseStatusUpdate {
  /** Current state from the SDK (RUNNING | STARTING | STOPPED | STOPPING | DELETED | DELETING). */
  state: sql.State;
  /** Milliseconds elapsed since `ensureWarehouseRunning` was called. */
  elapsedMs: number;
  /** 1-based attempt counter — useful for tests and telemetry. */
  attempt: number;
}

/** Options for {@link SQLWarehouseConnector.ensureWarehouseRunning}. */
interface EnsureWarehouseRunningOptions {
  /** Invoked every time the warehouse state changes during the wait. */
  onStatus: (update: WarehouseStatusUpdate) => void;
  /** Aborts the wait. The connector treats abort as `ExecutionError.canceled()`. */
  signal?: AbortSignal;
  /** Hard ceiling on the total wait. Defaults to {@link DEFAULT_WAREHOUSE_STARTUP_TIMEOUT_MS}. */
  timeoutMs?: number;
  /**
   * When `true` (default), a `STOPPED` warehouse is auto-started.
   * When `false`, `STOPPED` surfaces as `ConfigurationError` immediately —
   * useful for cost-controlled deployments that don't want any caller to
   * trigger billable warehouse starts.
   */
  autoStart?: boolean;
}

export class SQLWarehouseConnector {
  private readonly name = "sql-warehouse";

  private config: SQLWarehouseConfig;

  // Lazy-initialized: only created when Arrow format is used
  private _arrowProcessor: ArrowStreamProcessor | null = null;

  /**
   * Per-warehouse cache of the last RUNNING observation timestamp. Used by
   * {@link ensureWarehouseRunning} to short-circuit warm-path callers; see
   * {@link WAREHOUSE_RUNNING_CACHE_TTL_MS}.
   */
  private _recentlyRunning = new Map<string, number>();
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

  /**
   * Wait until the SQL warehouse is in the `RUNNING` state, auto-starting it
   * if currently `STOPPED`. Emits a {@link WarehouseStatusUpdate} whenever
   * the observed state changes, so callers can surface progress (e.g. over
   * SSE) instead of letting the UI freeze on a cold warehouse. Equal
   * successive observations are de-duplicated.
   *
   * Fast path: if this connector recently observed the warehouse RUNNING
   * (within {@link WAREHOUSE_RUNNING_CACHE_TTL_MS}), the call returns
   * immediately without any SDK round-trip or status emission. This keeps
   * cache-hit analytics requests off the Databricks control plane.
   *
   * Behaviour by initial state:
   * - `RUNNING`: emits one update, caches the observation, returns.
   * - `STOPPED`: emits a synthetic `STARTING` update, calls
   *   `workspaceClient.warehouses.start`, then polls until `RUNNING`.
   *   When `autoStart: false`, throws `ConfigurationError` instead.
   * - `STARTING` / `STOPPING`: polls until `RUNNING`.
   * - `DELETED` / `DELETING`: throws `ConfigurationError.resourceNotFound`.
   *
   * Aborts and timeouts surface as `ExecutionError`. The poll loop uses
   * exponential backoff with ±15% jitter (1s → 30s cap) and runs inside a
   * `sql.warehouseReady` telemetry span.
   */
  async ensureWarehouseRunning(
    workspaceClient: WorkspaceClient,
    warehouseId: string,
    opts: EnsureWarehouseRunningOptions,
  ): Promise<void> {
    const {
      onStatus,
      signal,
      timeoutMs = DEFAULT_WAREHOUSE_STARTUP_TIMEOUT_MS,
      autoStart = true,
    } = opts;

    if (signal?.aborted) throw ExecutionError.canceled();
    if (!warehouseId) throw ValidationError.missingField("warehouse_id");
    if (this._isRecentlyRunning(warehouseId)) return;

    return this.telemetry.startActiveSpan(
      "sql.warehouseReady",
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "db.system": "databricks",
          "db.warehouse_id": warehouseId,
          "db.warehouse.startup_timeout_ms": timeoutMs,
        },
      },
      async (span: Span) => {
        const startTime = Date.now();
        const emitter = new WarehouseStatusEmitter(span, startTime, onStatus);
        let didStart = false;
        const backoff = new WarehousePollBackoff();

        try {
          while (true) {
            if (signal?.aborted) throw ExecutionError.canceled();
            if (Date.now() - startTime > timeoutMs) {
              throw ExecutionError.statementFailed(
                `SQL warehouse did not reach RUNNING within ${timeoutMs}ms`,
              );
            }

            const info = await workspaceClient.warehouses.get(
              { id: warehouseId },
              this._createContext(signal),
            );
            const state = info?.state;
            const summary = info?.health?.summary;

            switch (state) {
              case "RUNNING":
                emitter.emit(state, summary);
                this._recentlyRunning.set(warehouseId, Date.now());
                span.setAttribute("db.warehouse.attempts", emitter.attempt);
                span.setStatus({ code: SpanStatusCode.OK });
                return;
              case "DELETED":
              case "DELETING":
                throw ConfigurationError.resourceNotFound(
                  "Warehouse ID",
                  `The configured SQL warehouse is ${state}. Update DATABRICKS_WAREHOUSE_ID to point at an active warehouse.`,
                );
              case "STOPPED":
                if (!autoStart) {
                  // The warehouse exists, it's just in the wrong state and
                  // policy forbids auto-starting it — use the base
                  // ConfigurationError directly so the message isn't
                  // prefixed with "not found".
                  throw new ConfigurationError(
                    "The configured SQL warehouse is STOPPED and analytics auto-start is disabled. Start the warehouse manually or set analytics.autoStartWarehouse=true.",
                  );
                }
                if (!didStart) {
                  emitter.emit("STARTING", summary);
                  await workspaceClient.warehouses.start(
                    { id: warehouseId },
                    this._createContext(signal),
                  );
                  didStart = true;
                } else {
                  // Warehouse fell back to STOPPED after our start attempt —
                  // surface the state and keep polling.
                  emitter.emit(state, summary);
                }
                break;
              case "STARTING":
              case "STOPPING":
                emitter.emit(state, summary);
                break;
              default:
                throw ExecutionError.unknownState(String(state ?? "unknown"));
            }

            // Preempt the next timeout check: if sleeping the full backoff
            // would push us past `timeoutMs`, throw now rather than waste
            // up to ~30s sleeping past the deadline (`backoff.next()` caps
            // at WAREHOUSE_POLL_MAX_MS).
            const sleepMs = backoff.next();
            if (Date.now() + sleepMs - startTime >= timeoutMs) {
              throw ExecutionError.statementFailed(
                `SQL warehouse did not reach RUNNING within ${timeoutMs}ms`,
              );
            }
            await this._sleepRespectingAbort(sleepMs, signal);
          }
        } catch (error) {
          this._throwSanitizedReadinessError(error, warehouseId, span);
        } finally {
          span.end();
        }
      },
      { name: this.name, includePrefix: true },
    );
  }

  /**
   * `true` if this connector observed `warehouseId` in the RUNNING state
   * within the recent-cache TTL.
   */
  private _isRecentlyRunning(warehouseId: string): boolean {
    const observedAt = this._recentlyRunning.get(warehouseId);
    return (
      observedAt !== undefined &&
      Date.now() - observedAt < WAREHOUSE_RUNNING_CACHE_TTL_MS
    );
  }

  /**
   * Final landing for any error thrown by the readiness poll loop. Records
   * the original on the span and (at debug level) on the logger, then
   * rethrows either the structured AppKitError unchanged or a curated
   * ExecutionError — never the raw SDK message, which can contain operator
   * internals.
   *
   * The `logger.debug` covers environments where OTel isn't configured
   * (common in dev) so the raw error isn't lost just because no span
   * exporter is hooked up.
   */
  private _throwSanitizedReadinessError(
    error: unknown,
    warehouseId: string,
    span: Span,
  ): never {
    if (error instanceof AppKitError) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.code });
      throw error;
    }
    span.recordException(
      error instanceof Error ? error : new Error(String(error)),
    );
    logger.debug(
      "Warehouse readiness check raw error for %s: %O",
      warehouseId,
      error,
    );
    const wrapped = ExecutionError.statementFailed(
      "Warehouse readiness check failed",
    );
    span.setStatus({ code: SpanStatusCode.ERROR, message: wrapped.code });
    throw wrapped;
  }

  /**
   * Sleep for `ms` milliseconds, but resolve early (and reject with
   * `ExecutionError.canceled()`) if `signal` aborts mid-sleep. Used by the
   * warehouse readiness loop so that client disconnects don't keep the loop
   * polling for the full interval.
   */
  private _sleepRespectingAbort(
    ms: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) return Promise.reject(ExecutionError.canceled());
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(ExecutionError.canceled());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
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

          // error logging is handled by executeStatement's catch block (gated on isAborted)
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
