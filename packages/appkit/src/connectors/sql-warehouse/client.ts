import type { TelemetryOptions } from "shared";
import {
  AppKitError,
  ConfigurationError,
  ConnectionError,
  ExecutionError,
  ValidationError,
} from "../../errors";
import { createLogger } from "../../logging/logger";
import {
  ArrowStreamProcessor,
  type RefreshChunkLink,
} from "../../stream/arrow-stream-processor";
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
  Context,
  type sql,
  type WorkspaceClient,
} from "../../workspace-client";
import { buildEmptyArrowIPCBase64 } from "./arrow-schema";
import { executeStatementDefaults } from "./defaults";
import { WarehousePollBackoff } from "./warehouse-poll-backoff";
import { WarehouseStatusEmitter } from "./warehouse-status-emitter";

const logger = createLogger("connectors:sql-warehouse");

/**
 * Real column names from a statement's result manifest (positional
 * `column_N` fallback for any blank ones). Databricks encodes ARROW_STREAM
 * schemas positionally (`col_0`, …); these names let consumers relabel an
 * Arrow result to match the JSON path. Returns `undefined` when the manifest
 * carries no columns.
 */
function arrowColumnNames(
  response: sql.StatementResponse,
): string[] | undefined {
  const cols = response.manifest?.schema?.columns;
  if (!cols || cols.length === 0) return undefined;
  return cols.map((c, i) =>
    c.name && c.name.length > 0 ? c.name : `column_${i}`,
  );
}

/**
 * Maximum size for inline Arrow IPC attachments (25 MiB decoded — the
 * Databricks Statement Execution API hard cap on INLINE responses).
 *
 * The analytics route streams the decoded attachment straight back on the
 * query response body; this cap bounds the single in-memory copy. Larger
 * results fall through to `disposition: "EXTERNAL_LINKS"`, which streams
 * chunk-by-chunk and is not bound by this limit.
 */
const MAX_INLINE_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Safety cap on how many additional EXTERNAL_LINKS chunks
 * {@link SQLWarehouseConnector._resolveAllExternalLinks} will follow when the
 * manifest omits `total_chunk_count`. High enough to cover any real result;
 * only bounds a misbehaving warehouse with a cyclic `next_chunk_index`.
 */
const MAX_EXTERNAL_CHUNK_FOLLOWS = 10_000;

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
  /** @internal Fired once when `warehouses.start` is issued for this poll. */
  onWarehouseStartIssued?: () => void;
}

/** In-flight warehouse readiness work shared across concurrent callers. */
interface WarehouseReadinessInFlight {
  promise: Promise<void>;
  refCount: number;
  sharedController: AbortController;
  subscribers: Set<(update: WarehouseStatusUpdate) => void>;
  /** Last emitted update; replayed to late joiners. */
  lastUpdate: WarehouseStatusUpdate | null;
  /** `true` once this poll has called `warehouses.start`. */
  warehouseStartIssued: boolean;
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
  /** Per-warehouse readiness singleflight — one poll loop per cold start. */
  private _readinessInFlight = new Map<string, WarehouseReadinessInFlight>();
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
              result = await this._transformDataArray(
                response,
                workspaceClient,
                signal,
              );
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

            logger.error(
              "Statement execution failed: %s",
              error instanceof Error ? error.message : String(error),
            );
          }

          this._rethrowStatementError(error);
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
   * Concurrent callers for the same `warehouseId` share a single in-flight
   * poll loop (singleflight): only the owner issues `get`/`start`; joiners
   * receive broadcast `onStatus` updates and share the result promise.
   * When every waiter disconnects before `warehouses.start`, the shared poll
   * is aborted on the next microtask if still unclaimed (kills true orphans
   * without a fixed grace window). After `start` is issued, the poll runs to
   * completion even with no waiters.
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

    const existing = this._readinessInFlight.get(warehouseId);
    if (existing && !existing.sharedController.signal.aborted) {
      return this._waitOnReadiness(existing, onStatus, signal, true);
    }

    const entry = this._spawnReadinessInFlight(workspaceClient, warehouseId, {
      timeoutMs,
      autoStart,
    });
    this._readinessInFlight.set(warehouseId, entry);
    return this._waitOnReadiness(entry, onStatus, signal, false);
  }

  private _waitOnReadiness(
    entry: WarehouseReadinessInFlight,
    onStatus: (update: WarehouseStatusUpdate) => void,
    signal: AbortSignal | undefined,
    join: boolean,
  ): Promise<void> {
    if (signal?.aborted) throw ExecutionError.canceled();
    if (join) entry.refCount++;
    entry.subscribers.add(onStatus);
    if (entry.lastUpdate) onStatus(entry.lastUpdate);
    return this._joinWarehouseReadiness(entry, signal);
  }

  private _spawnReadinessInFlight(
    workspaceClient: WorkspaceClient,
    warehouseId: string,
    opts: { timeoutMs: number; autoStart: boolean },
  ): WarehouseReadinessInFlight {
    const sharedController = new AbortController();
    const entry: WarehouseReadinessInFlight = {
      refCount: 1,
      sharedController,
      subscribers: new Set(),
      lastUpdate: null,
      warehouseStartIssued: false,
      promise: Promise.resolve(),
    };

    entry.promise = this.telemetry
      .startActiveSpan(
        "sql.warehouseReady",
        {
          kind: SpanKind.CLIENT,
          attributes: {
            "db.system": "databricks",
            "db.warehouse_id": warehouseId,
            "db.warehouse.startup_timeout_ms": opts.timeoutMs,
          },
        },
        async (span: Span) => {
          try {
            await this._pollUntilWarehouseRunning(
              workspaceClient,
              warehouseId,
              {
                onStatus: (update) => this._broadcastReadiness(entry, update),
                signal: sharedController.signal,
                timeoutMs: opts.timeoutMs,
                autoStart: opts.autoStart,
                onWarehouseStartIssued: () => {
                  entry.warehouseStartIssued = true;
                },
              },
              span,
            );
            span.setStatus({ code: SpanStatusCode.OK });
          } catch (error) {
            this._throwSanitizedReadinessError(error, warehouseId, span);
          } finally {
            span.end();
          }
        },
        { name: this.name, includePrefix: true },
      )
      .finally(() => {
        if (this._readinessInFlight.get(warehouseId) === entry) {
          this._readinessInFlight.delete(warehouseId);
        }
      });

    entry.promise.catch(() => {});
    return entry;
  }

  private _broadcastReadiness(
    entry: WarehouseReadinessInFlight,
    update: WarehouseStatusUpdate,
  ): void {
    entry.lastUpdate = update;
    for (const subscriber of entry.subscribers) {
      try {
        subscriber(update);
      } catch {
        // One consumer must not block updates to the rest.
      }
    }
  }

  /** Ref-counted await; caller abort rejects locally. */
  private _joinWarehouseReadiness(
    entry: WarehouseReadinessInFlight,
    callerSignal?: AbortSignal,
  ): Promise<void> {
    if (!callerSignal) return entry.promise;

    return new Promise<void>((resolve, reject) => {
      let done = false;
      const finish = (outcome: "ok" | "abort" | "err", error?: unknown) => {
        if (done) return;
        done = true;
        callerSignal.removeEventListener("abort", onAbort);
        if (outcome === "ok") resolve();
        else if (outcome === "abort") reject(ExecutionError.canceled());
        else reject(error);
      };
      const onAbort = () => {
        this._releaseReadinessWaiter(entry);
        finish("abort");
      };
      callerSignal.addEventListener("abort", onAbort, { once: true });
      entry.promise.then(
        () => finish("ok"),
        (error) => finish("err", error),
      );
    });
  }

  private _releaseReadinessWaiter(entry: WarehouseReadinessInFlight): void {
    if (entry.refCount > 0) entry.refCount--;
    if (entry.refCount > 0 || entry.sharedController.signal.aborted) return;

    if (entry.warehouseStartIssued) {
      // Start already issued — finish warming for the process.
      return;
    }

    // Defer abort to the next microtask so a synchronous StrictMode
    // remount can rejoin before the shared poll is cancelled.
    queueMicrotask(() => {
      if (entry.refCount <= 0 && !entry.sharedController.signal.aborted) {
        entry.sharedController.abort("all warehouse readiness waiters aborted");
      }
    });
  }

  private async _pollUntilWarehouseRunning(
    workspaceClient: WorkspaceClient,
    warehouseId: string,
    opts: EnsureWarehouseRunningOptions,
    span: Span,
  ): Promise<void> {
    const {
      onStatus,
      signal,
      timeoutMs = DEFAULT_WAREHOUSE_STARTUP_TIMEOUT_MS,
      autoStart = true,
      onWarehouseStartIssued,
    } = opts;
    const startTime = Date.now();
    const emitter = new WarehouseStatusEmitter(span, startTime, onStatus);
    let didStart = false;
    const backoff = new WarehousePollBackoff();

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
          return;
        case "DELETED":
        case "DELETING":
          throw ConfigurationError.resourceNotFound(
            "Warehouse ID",
            `The configured SQL warehouse is ${state}. Update DATABRICKS_WAREHOUSE_ID to point at an active warehouse.`,
          );
        case "STOPPED":
          if (!autoStart) {
            throw new ConfigurationError(
              "The configured SQL warehouse is STOPPED and analytics auto-start is disabled. Start the warehouse manually or set analytics.autoStartWarehouse=true.",
            );
          }
          if (!didStart) {
            emitter.emit("STARTING", summary);
            onWarehouseStartIssued?.();
            await workspaceClient.warehouses.start(
              { id: warehouseId },
              this._createContext(signal),
            );
            didStart = true;
          } else {
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

      const sleepMs = backoff.next();
      if (Date.now() + sleepMs - startTime >= timeoutMs) {
        throw ExecutionError.statementFailed(
          `SQL warehouse did not reach RUNNING within ${timeoutMs}ms`,
        );
      }
      await this._sleepRespectingAbort(sleepMs, signal);
    }
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
                return this._transformDataArray(
                  response,
                  workspaceClient,
                  signal,
                );
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

          // error logging is handled by executeStatement's catch block (gated on isAborted)
          this._rethrowStatementError(error);
        } finally {
          span.end();
        }
      },
      { name: this.name, includePrefix: true },
    );
  }

  private async _transformDataArray(
    response: sql.StatementResponse,
    workspaceClient: WorkspaceClient,
    signal?: AbortSignal,
  ) {
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

      // External links: data fetched separately via statement_id. An empty
      // array is a zero-row result (some warehouses emit `external_links: []`
      // rather than omitting it) — it must NOT go down the streaming path
      // (`streamChunks([])` rejects), so fall through to synthesize an empty
      // Arrow table below.
      if (result?.external_links && result.external_links.length > 0) {
        return this.updateWithArrowStatus(response, workspaceClient, signal);
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
   * Validate a base64 Arrow IPC attachment (INLINE ARROW_STREAM) and attach
   * the real column names from the result manifest.
   *
   * Databricks warehouses encode the Arrow schema positionally (`col_0`, …);
   * the real, aliased names live only in `manifest.schema.columns`. Rather
   * than decode/re-encode the payload server-side, we carry the names on the
   * result (`columnNames`) so the route can hand them to the client in a
   * response header and the client relabels the decoded Table — the one
   * mechanism used for both INLINE and EXTERNAL_LINKS.
   */
  private _validateArrowAttachment(
    response: sql.StatementResponse,
    attachment: string,
  ) {
    // Cap the size to protect against unbounded inline payloads from
    // misbehaving warehouses. `MAX_INLINE_ATTACHMENT_BYTES` tracks the API's
    // ~25 MiB inline hard cap and bounds memory if a server returns a runaway
    // response.
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

    const columnNames = arrowColumnNames(response);
    if (columnNames) {
      return {
        ...response,
        result: {
          ...(response.result as sql.ResultData & {
            attachment?: string;
            columnNames?: string[];
          }),
          // `statement_id` is a top-level field, not on `ResultData` — carry it
          // onto the result (as the EXTERNAL_LINKS path does) so the route can
          // advertise it in `X-Appkit-Arrow-Columns-Ref` for wide inline schemas.
          statement_id: response.statement_id,
          columnNames,
        },
      };
    }

    return response;
  }

  private async updateWithArrowStatus(
    response: sql.StatementResponse,
    workspaceClient: WorkspaceClient,
    signal?: AbortSignal,
  ): Promise<{
    result: {
      statement_id: string;
      status: sql.StatementStatus;
      columnNames?: string[];
      external_links?: sql.ExternalLink[];
      refreshChunkLink?: RefreshChunkLink;
    };
  }> {
    const statementId = response.statement_id as string;
    return {
      result: {
        statement_id: statementId,
        status: {
          state: response.status?.state,
          error: response.status?.error,
        } as sql.StatementStatus,
        columnNames: arrowColumnNames(response),
        // Resolve the pre-signed links for EVERY chunk in the caller's own
        // execution context. Streaming these directly (see
        // {@link streamExternalLinks}) avoids a second `getStatement` under
        // the ambient service-principal context — which would fail for
        // `.obo.sql` (user-owned) statements.
        external_links: await this._resolveAllExternalLinks(
          workspaceClient,
          statementId,
          response,
          signal,
        ),
        // Bound to this caller's identity so the streamer can re-mint an
        // expired chunk link mid-download (links live <= 15 min; a large/slow
        // result can outlast the earliest ones).
        refreshChunkLink: this._makeChunkLinkRefresher(
          workspaceClient,
          statementId,
        ),
      },
    };
  }

  /**
   * Resolve pre-signed links for EVERY chunk of an EXTERNAL_LINKS result.
   *
   * The execute/getStatement response carries only the first chunk's links
   * (each link, except the last, exposes `next_chunk_index`); the remaining
   * chunks are fetched with `getStatementResultChunkN`. Runs in the caller's
   * identity context (user creds for `.obo.sql`), so there is no cross-identity
   * fetch. Only the tiny link metadata is resolved eagerly — the bytes still
   * stream one chunk at a time downstream. Without this a multi-chunk result
   * would be silently truncated to its first chunk.
   */
  private async _resolveAllExternalLinks(
    workspaceClient: WorkspaceClient,
    statementId: string,
    response: sql.StatementResponse,
    signal?: AbortSignal,
  ): Promise<sql.ExternalLink[] | undefined> {
    const first = response.result?.external_links;
    if (!first || first.length === 0) return first;

    const links: sql.ExternalLink[] = [...first];
    // Bound the follow loop so a warehouse returning a cyclic/never-ending
    // `next_chunk_index` can't spin forever. The manifest's chunk count is the
    // natural bound; fall back to a generous safety cap if it's absent (real
    // results still terminate earlier when `next_chunk_index` becomes null) so
    // a missing count doesn't silently truncate a genuine multi-chunk result.
    const maxFetches =
      response.manifest?.total_chunk_count ?? MAX_EXTERNAL_CHUNK_FOLLOWS;
    let next = this._nextChunkIndex(first);
    for (let fetches = 0; next != null && fetches < maxFetches; fetches++) {
      if (signal?.aborted) throw ExecutionError.canceled();
      const chunk =
        await workspaceClient.statementExecution.getStatementResultChunkN(
          { statement_id: statementId, chunk_index: next },
          this._createContext(signal),
        );
      const chunkLinks = chunk.external_links ?? [];
      if (chunkLinks.length === 0) break;
      links.push(...chunkLinks);
      next = this._nextChunkIndex(chunkLinks);
    }
    return links;
  }

  /** The `next_chunk_index` advertised by a chunk's links, if any. */
  private _nextChunkIndex(links: sql.ExternalLink[]): number | undefined {
    for (const link of links) {
      if (link.next_chunk_index != null) return link.next_chunk_index;
    }
    return undefined;
  }

  /**
   * A closure that re-mints a single chunk's pre-signed link via
   * `getStatementResultChunkN`, bound to the caller's workspace client +
   * statement id. Created here (in the caller's identity context) so the
   * streamer — which runs outside that context — can refresh an expired link
   * for `.obo.sql` statements without a cross-identity `getStatement`.
   */
  private _makeChunkLinkRefresher(
    workspaceClient: WorkspaceClient,
    statementId: string,
  ): RefreshChunkLink {
    return async (chunkIndex, signal) => {
      const chunk =
        await workspaceClient.statementExecution.getStatementResultChunkN(
          { statement_id: statementId, chunk_index: chunkIndex },
          this._createContext(signal),
        );
      return chunk.external_links?.find((l) => l.chunk_index === chunkIndex);
    };
  }

  /**
   * Stream already-resolved EXTERNAL_LINKS chunks as raw Arrow IPC bytes, one
   * chunk in memory at a time. Takes the `external_links` the caller already
   * has from `executeStatement` (see {@link updateWithArrowStatus}), so there
   * is no extra `getStatement` round-trip and no execution-context mismatch —
   * the pre-signed URLs need no auth to download.
   */
  streamExternalLinks(
    chunks: sql.ExternalLink[],
    signal?: AbortSignal,
    refresh?: RefreshChunkLink,
  ): AsyncGenerator<Uint8Array, void, unknown> {
    return this.arrowProcessor.streamChunks(chunks, signal, refresh);
  }

  /**
   * Fetch just the real column names for a completed statement from its result
   * manifest — no result data. Backs the `/columns/:statementId` fallback the
   * client uses when a very wide schema's names exceed the response-header
   * size limit. Stateless: re-derives from the warehouse, no server cache.
   */
  async getColumnNames(
    workspaceClient: WorkspaceClient,
    jobId: string,
    signal?: AbortSignal,
  ): Promise<string[] | undefined> {
    const response = await workspaceClient.statementExecution.getStatement(
      { statement_id: jobId },
      this._createContext(signal),
    );
    return arrowColumnNames(response);
  }

  /**
   * Normalize an error caught during statement execution/polling and rethrow.
   * Abort and already-structured `AppKitError`s pass through untouched;
   * anything else is wrapped as an `ExecutionError`, preserving the SDK's
   * structured `ApiError.errorCode` (e.g. "INVALID_PARAMETER_VALUE",
   * "BAD_REQUEST") so callers can branch on a stable identifier rather than
   * substring-matching the message.
   */
  private _rethrowStatementError(error: unknown): never {
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
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
