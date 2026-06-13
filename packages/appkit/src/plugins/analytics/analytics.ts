import type { WorkspaceClient } from "@databricks/sdk-experimental";
import { type DataType, Type, tableFromIPC } from "apache-arrow";
import type express from "express";
import {
  type AgentToolDefinition,
  type AnalyticsSseMessage,
  type IAppRouter,
  makeArrowMessage,
  makeResultMessage,
  type PluginExecuteConfig,
  type SQLTypeMarker,
  type StreamExecutionSettings,
  type ToolProvider,
} from "shared";
import { z } from "zod";
import { SQLWarehouseConnector } from "../../connectors";
import {
  DEFAULT_WAREHOUSE_STARTUP_TIMEOUT_MS,
  type WarehouseStatusUpdate,
} from "../../connectors/sql-warehouse/client";
import { getWarehouseId, getWorkspaceClient } from "../../context";
import { buildToolkitEntries } from "../../core/agent/build-toolkit";
import {
  defineTool,
  executeFromRegistry,
  toolsFromRegistry,
} from "../../core/agent/tools/define-tool";
import { assertReadOnlySql } from "../../core/agent/tools/sql-policy";
import { AppKitError, ExecutionError } from "../../errors";
import { createLogger } from "../../logging/logger";
import { Plugin, toPlugin } from "../../plugin";
import type { PluginManifest } from "../../registry";
import type { Counter, Histogram } from "../../telemetry";
import { queryDefaults } from "./defaults";
import { InlineArrowStash } from "./inline-arrow-stash";
import manifest from "./manifest.json";
import { QueryProcessor } from "./query";
import {
  type AnalyticsFormat,
  type AnalyticsQueryResponse,
  type AnalyticsStreamMessage,
  type IAnalyticsConfig,
  type IAnalyticsQueryRequest,
  normalizeAnalyticsFormat,
  type WarehouseStatus,
} from "./types";

const logger = createLogger("analytics");

/**
 * Bridges a callback-emitting async function into an async iterable.
 *
 * `start(emit)` runs concurrently; every value passed to `emit` is yielded
 * in order. The iterable completes when `start`'s promise resolves and
 * re-throws (after draining) if it rejects. Lets a callback-based progress
 * API (e.g. SQL warehouse readiness) be consumed with `for await`.
 */
async function* streamCallbacks<T>(
  start: (emit: (value: T) => void) => Promise<void>,
): AsyncGenerator<T, void, unknown> {
  const queue: T[] = [];
  let wake: (() => void) | null = null;
  let settled = false;
  let error: unknown = null;

  const notify = (): void => {
    wake?.();
    wake = null;
  };

  // The .then(_, err => ...) chain converts a rejection into a resolved
  // promise; the consumer surfaces `error` after draining the queue.
  void start((value) => {
    queue.push(value);
    notify();
  }).then(
    () => {
      settled = true;
      notify();
    },
    (err) => {
      error = err;
      settled = true;
      notify();
    },
  );

  while (!settled || queue.length > 0) {
    while (queue.length > 0) yield queue.shift() as T;
    if (settled) break;
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
  }
  if (error) throw error;
}

export class AnalyticsPlugin extends Plugin implements ToolProvider {
  /** Plugin manifest declaring metadata and resource requirements */
  static manifest = manifest as PluginManifest<"analytics">;

  protected static description = "Analytics plugin for data analysis";
  protected declare config: IAnalyticsConfig;

  // analytics services
  private SQLClient: SQLWarehouseConnector;
  private queryProcessor: QueryProcessor;

  /**
   * Server-side stash for inline Arrow IPC payloads.
   *
   * INLINE ARROW_STREAM responses do not ride the SSE control channel —
   * the route puts the decoded bytes here and emits an `arrow` SSE
   * message with a synthetic `inline-<uuid>` id, and the client fetches
   * the bytes through the existing `/arrow-result/:jobId` endpoint with
   * a real binary content-type.
   */
  protected inlineArrowStash: InlineArrowStash = new InlineArrowStash();

  /**
   * Stash telemetry — created lazily on first stash operation because
   * `this.telemetry` may not be bound at constructor time (see
   * `Plugin.attachContext`). Cached via `_stashMetrics` after the first
   * call; subsequent puts hit the cached counter/histogram instances.
   *
   * Counter labels: `result` ∈ {"regular", "overflow", "exhausted"} —
   * one counter with a label is friendlier to dashboards than three
   * separate metrics, and aggregates trivially in Prometheus / OTel.
   */
  private _stashMetrics?: {
    putCount: Counter;
    putBytes: Histogram;
  };
  private _stashMetricsAttempted = false;

  constructor(config: IAnalyticsConfig) {
    super(config);
    this.config = config;
    this.queryProcessor = new QueryProcessor();

    this.SQLClient = new SQLWarehouseConnector({
      timeout: config.timeout,
      telemetry: config.telemetry,
    });
  }

  injectRoutes(router: IAppRouter) {
    // Arrow data downloads always run as service principal and bypass the
    // interceptor chain (execute/executeStream). The original query execution
    // handles OBO via executeStream(); this endpoint fetches pre-computed
    // results by job ID.
    this.route(router, {
      name: "arrow",
      method: "get",
      path: "/arrow-result/:jobId",
      handler: async (req: express.Request, res: express.Response) => {
        await this._handleArrowRoute(req, res);
      },
    });

    this.route<AnalyticsQueryResponse>(router, {
      name: "query",
      method: "post",
      path: "/query/:query_key",
      handler: async (req: express.Request, res: express.Response) => {
        await this._handleQueryRoute(req, res);
      },
    });
  }

  /**
   * Handle Arrow data download requests.
   *
   * Two id shapes are supported:
   * - `inline-<uuid>`: bytes were stashed server-side by the query route.
   *   Drain the stash, serve directly with the canonical Arrow content
   *   type. No warehouse round-trip.
   * - any other id: a warehouse-issued statement id. Fetch the Arrow
   *   stream from the warehouse via the SDK; serve the bytes.
   *
   * When called via asUser(req), uses the user's Databricks credentials
   * for the warehouse path. The inline path is user-scoped at the stash
   * layer instead.
   */
  async _handleArrowRoute(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const { jobId } = req.params;
    const event = logger.event(req);
    event?.setComponent("analytics", "getArrowData").setContext("analytics", {
      job_id: jobId,
      plugin: this.name,
    });

    if (jobId.startsWith("inline-")) {
      const userKey = this._stashUserKey(req);
      const bytes = this.inlineArrowStash.take(jobId, userKey);
      if (!bytes) {
        // Already drained, expired, or never belonged to this user. 410
        // distinguishes this from "warehouse statement id not found" (404)
        // so the client can surface a useful error.
        logger.debug("Inline Arrow stash miss for jobId=%s", jobId);
        res.status(410).json({
          error: "Inline Arrow result expired or unknown",
          plugin: this.name,
        });
        return;
      }
      logger.debug(
        "Serving inline Arrow buffer: %d bytes for jobId=%s",
        bytes.length,
        jobId,
      );
      res.setHeader("Content-Type", "application/vnd.apache.arrow.stream");
      res.setHeader("Content-Length", bytes.length.toString());
      // Inline payloads are single-use and short-lived; no public caching.
      res.setHeader("Cache-Control", "no-store");
      res.send(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      return;
    }

    try {
      const workspaceClient = getWorkspaceClient();
      logger.debug("Processing Arrow job request for jobId=%s", jobId);

      const result = await this.getArrowData(workspaceClient, jobId);

      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Length", result.data.length.toString());
      res.setHeader("Cache-Control", "public, max-age=3600");

      logger.debug(
        "Sending Arrow buffer: %d bytes for job %s",
        result.data.length,
        jobId,
      );
      res.send(Buffer.from(result.data));
    } catch (error) {
      logger.error("Arrow job error: %O", error);
      // Do not echo upstream / SDK error text to the client — it can
      // include statement fragments, internal object names, and
      // correlation IDs. The full detail stays in the server log above.
      const errorCode =
        error instanceof ExecutionError ? error.errorCode : undefined;
      res.status(404).json({
        error: "Arrow result unavailable",
        errorCode,
        plugin: this.name,
      });
    }
  }

  /**
   * Lazy accessor for stash telemetry instruments. Returns `undefined`
   * when telemetry isn't bound (factory-constructed plugins before
   * `attachContext`, no-op test paths) — callers should branch on the
   * return value rather than relying on it being present.
   *
   * Records once per call site:
   * - `analytics.inline_arrow_stash.put.count{result}` — counter with
   *   label "regular" | "overflow" | "exhausted"
   * - `analytics.inline_arrow_stash.put.bytes` — histogram of accepted
   *   payload sizes (label same as counter; exhausted puts record 0)
   */
  private _getStashMetrics() {
    if (this._stashMetricsAttempted) return this._stashMetrics;
    this._stashMetricsAttempted = true;
    if (!this.telemetry) return undefined;
    const meter = this.telemetry.getMeter();
    this._stashMetrics = {
      putCount: meter.createCounter("analytics.inline_arrow_stash.put.count", {
        description:
          "Count of inline-Arrow stash put attempts, labeled by pool outcome (regular | overflow | exhausted).",
        unit: "1",
      }),
      putBytes: meter.createHistogram(
        "analytics.inline_arrow_stash.put.bytes",
        {
          description:
            "Sizes of accepted inline-Arrow stash payloads. Aggregate by `result` label for utilization analysis.",
          unit: "By",
        },
      ),
    };
    return this._stashMetrics;
  }

  private _recordStashOutcome(
    result: "regular" | "overflow" | "exhausted",
    bytes: number,
  ): void {
    const m = this._getStashMetrics();
    if (!m) return;
    m.putCount.add(1, { result });
    m.putBytes.record(result === "exhausted" ? 0 : bytes, { result });
  }

  /**
   * Stash key used at put-time (in `_handleQueryRoute`) and take-time
   * (in `_handleArrowRoute`). Centralized so the two sides cannot drift.
   *
   * Returns the user id when an `x-forwarded-user` header is present,
   * otherwise `"global"` for service-principal contexts (no user header).
   * Both queries from the same request resolve to the same key, so the
   * subsequent /arrow-result fetch reliably hits the entry stashed
   * during the SSE query.
   *
   * `resolveUserId` throws when no header is present — catch and degrade
   * to "global" rather than letting that failure mode bubble through the
   * route handler.
   */
  protected _stashUserKey(req: express.Request): string {
    try {
      return this.resolveUserId(req) || "global";
    } catch {
      return "global";
    }
  }

  /**
   * Handle SQL query execution requests.
   * When called via asUser(req), uses the user's Databricks credentials.
   */
  async _handleQueryRoute(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const { query_key } = req.params;
    const { parameters, format: rawFormat = "JSON_ARRAY" } =
      req.body as IAnalyticsQueryRequest;

    if (
      rawFormat !== "JSON_ARRAY" &&
      rawFormat !== "ARROW_STREAM" &&
      rawFormat !== "JSON" &&
      rawFormat !== "ARROW"
    ) {
      res.status(400).json({
        error: `Invalid format: ${String(rawFormat)}. Expected "JSON_ARRAY" or "ARROW_STREAM".`,
      });
      return;
    }

    const format = normalizeAnalyticsFormat(rawFormat);

    // Request-scoped logging with WideEvent tracking
    logger.debug(req, "Executing query: %s (format=%s)", query_key, format);

    const event = logger.event(req);
    event?.setComponent("analytics", "executeQuery").setContext("analytics", {
      query_key,
      format,
      parameter_count: parameters ? Object.keys(parameters).length : 0,
      plugin: this.name,
    });

    if (!query_key) {
      res.status(400).json({ error: "query_key is required" });
      return;
    }

    const queryResult = await this.app.getAppQuery(
      query_key,
      req,
      this.devFileReader,
    );

    if (!queryResult) {
      res.status(404).json({ error: "Query not found" });
      return;
    }

    const { query, isAsUser } = queryResult;

    // get execution context - user-scoped if .obo.sql, otherwise service principal
    const executor = isAsUser ? this.asUser(req) : this;
    const executorKey = isAsUser ? this.resolveUserId(req) : "global";
    // Stash key is always per-request user (never "global"), independent
    // of the executor's cache scope. Inline Arrow payloads are single-use
    // and short-lived — there is no benefit to sharing them across users,
    // and per-user scoping is defense in depth on top of unguessable ids.
    const stashUserKey = this._stashUserKey(req);

    const hashedQuery = this.queryProcessor.hashQuery(query);

    // ARROW_STREAM responses reference ephemeral resources that cannot be
    // safely replayed from cache:
    // - EXTERNAL_LINKS pre-signed URLs expire ~15 min after issue, and
    //   the warehouse rotates them per execution.
    // - INLINE responses point at a synthetic `inline-<uuid>` job id
    //   backed by `InlineArrowStash`, which drains on the first
    //   /arrow-result fetch. A cache hit would replay an id whose bytes
    //   are already gone and reliably 410 the client.
    // So we bypass cache for ARROW_STREAM and let every request execute
    // a fresh statement. JSON_ARRAY responses still cache normally.
    const cacheTtl = format === "ARROW_STREAM" ? 0 : queryDefaults.cache?.ttl;
    const cacheConfig = {
      ...queryDefaults.cache,
      ttl: cacheTtl,
      cacheKey: [
        "analytics:query",
        query_key,
        JSON.stringify(parameters),
        format,
        hashedQuery,
        executorKey,
      ],
    };

    // Cache/retry/timeout are scoped to the SQL execution itself (inner
    // `execute`) so the warehouse-readiness phase isn't subject to retries
    // and the generator value never leaks into the cache.
    const sqlConfig: PluginExecuteConfig = {
      ...queryDefaults,
      cache: cacheConfig,
    };

    // Outer stream: no cache/retry — `executeStream` would otherwise wrap the
    // generator factory and cache the generator object itself. Telemetry +
    // user-scoped trace context still apply.
    const streamExecutionSettings: StreamExecutionSettings = {
      default: {
        cache: { enabled: false },
        retry: { enabled: false },
      },
    };

    const startupTimeoutMs =
      this.config.warehouseStartupTimeoutMs ??
      DEFAULT_WAREHOUSE_STARTUP_TIMEOUT_MS;
    const autoStartWarehouse = this.config.autoStartWarehouse ?? true;

    const self = this;

    await executor.executeStream(
      res,
      async function* (
        signal,
      ): AsyncGenerator<AnalyticsStreamMessage, void, unknown> {
        const workspaceClient = getWorkspaceClient();
        const warehouseId = await getWarehouseId();

        // Stream warehouse-readiness updates as SSE events, then run SQL.
        const readinessUpdates = streamCallbacks<WarehouseStatusUpdate>(
          (emit) =>
            self.SQLClient.ensureWarehouseRunning(
              workspaceClient,
              warehouseId,
              {
                signal,
                timeoutMs: startupTimeoutMs,
                autoStart: autoStartWarehouse,
                onStatus: emit,
              },
            ),
        );
        for await (const update of readinessUpdates) {
          yield {
            type: "warehouse_status",
            status: {
              state: update.state as WarehouseStatus["state"],
              elapsedMs: update.elapsedMs,
            },
          };
        }

        // `execute()` reduces a thrown error to `{ status, message }`,
        // dropping the rich fields (`errorCode`, `clientMessage`) the
        // fallback's `ExecutionError`s carry. Capture the original here so
        // we can re-throw it intact — the SSE error path
        // (`StreamManager`) reads `errorCode`/`clientMessage` off it.
        let originalError: unknown;
        const sqlResult = await executor.execute(
          async (sig) => {
            try {
              const processedParams =
                await self.queryProcessor.processQueryParams(query, parameters);
              // Disposition/format fallback (inline-arrow stash, JSON_ARRAY↔
              // ARROW_STREAM retries) lives in `_executeWithFormatFallback`,
              // which returns the SSE message the client should receive.
              return await self._executeWithFormatFallback(
                executor,
                query,
                processedParams,
                format,
                stashUserKey,
                sig,
              );
            } catch (err) {
              originalError = err;
              throw err;
            }
          },
          { default: sqlConfig },
          executorKey,
        );

        if (!sqlResult.ok) {
          const msg = sqlResult.message;
          const lower = msg.toLowerCase();
          if (
            lower.includes("operation was aborted") ||
            lower.includes("the request was aborted") ||
            lower.includes("statement was canceled")
          ) {
            const err = new DOMException(
              lower.includes("canceled") ? msg : "The operation was aborted.",
              "AbortError",
            );
            throw err;
          }
          // Re-throw the original error so its structured `errorCode` (e.g.
          // INLINE_ARROW_STASH_EXHAUSTED) and sanitized `clientMessage`
          // survive to the SSE error payload. Fall back to a generic
          // statement failure only if the original wasn't an AppKitError.
          if (originalError instanceof AppKitError) {
            throw originalError;
          }
          const inner = msg.startsWith("Statement failed: ")
            ? msg.slice("Statement failed: ".length)
            : msg;
          throw ExecutionError.statementFailed(inner);
        }

        yield sqlResult.data as AnalyticsStreamMessage;
      },
      streamExecutionSettings,
      executorKey,
    );
  }

  /**
   * Execute a query with automatic disposition/format fallback.
   *
   * - **JSON_ARRAY** first tries `INLINE + JSON_ARRAY`. If the warehouse
   *   only supports `ARROW_STREAM` for `INLINE` (some serverless variants),
   *   retries as `INLINE + ARROW_STREAM`, decodes the Arrow IPC attachment
   *   server-side, and returns plain row objects — the caller's
   *   `JSON_ARRAY` contract is preserved.
   * - **ARROW_STREAM** first tries `INLINE + ARROW_STREAM`. If the
   *   warehouse refuses (most classic + some serverless variants), falls
   *   back to `EXTERNAL_LINKS + ARROW_STREAM`. When the regular stash is
   *   full, the already-decoded bytes spill into the stash's overflow
   *   pool — never thrown away to trigger a second warehouse round-trip.
   *
   * INLINE Arrow attachments under the ARROW_STREAM path are decoded once
   * and put on the plugin's `inlineArrowStash`; the SSE message carries the
   * synthetic stash id so the client fetches the bytes out-of-band via
   * `/arrow-result/<id>`.
   */
  private async _executeWithFormatFallback(
    executor: AnalyticsPlugin,
    query: string,
    processedParams:
      | Record<string, SQLTypeMarker | null | undefined>
      | undefined,
    requestedFormat: AnalyticsFormat,
    stashUserKey: string,
    signal?: AbortSignal,
  ): Promise<AnalyticsSseMessage> {
    return requestedFormat === "JSON_ARRAY"
      ? this._executeJsonArrayPath(executor, query, processedParams, signal)
      : this._executeArrowStreamPath(
          executor,
          query,
          processedParams,
          stashUserKey,
          signal,
        );
  }

  /**
   * JSON_ARRAY path. Tries `INLINE + JSON_ARRAY` first; on a structured
   * `needs-arrow` rejection (warehouse only accepts ARROW_STREAM under
   * INLINE), retries as `INLINE + ARROW_STREAM` and decodes the Arrow
   * IPC attachment server-side so the caller's JSON_ARRAY contract is
   * preserved.
   *
   * Failure modes surfaced to the caller:
   * - Unrelated warehouse errors (anything not classified as
   *   `needs-arrow`) propagate untouched.
   * - The retry can throw `ExecutionError.missingData("ARROW_STREAM
   *   attachment")` if the warehouse returned no attachment.
   * - The decode itself can throw `RESULT_TOO_LARGE_FOR_JSON_FALLBACK`
   *   when the attachment exceeds the row or byte cap.
   */
  private async _executeJsonArrayPath(
    executor: AnalyticsPlugin,
    query: string,
    processedParams:
      | Record<string, SQLTypeMarker | null | undefined>
      | undefined,
    signal?: AbortSignal,
  ): Promise<AnalyticsSseMessage> {
    try {
      const result = await executor.query(
        query,
        processedParams,
        { disposition: "INLINE", format: "JSON_ARRAY" },
        signal,
      );
      return makeResultMessage(result?.data, {
        status: result?.status,
        statement_id: result?.statement_id,
      });
    } catch (err: unknown) {
      if (signal?.aborted) throw err;
      if (_classifyInlineRejection(err) !== "needs-arrow") throw err;

      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        "JSON_ARRAY INLINE rejected by warehouse, retrying as ARROW_STREAM INLINE and decoding server-side: %s",
        msg,
      );
    }

    // Retry as ARROW_STREAM + INLINE so the warehouse will accept the
    // request, then decode the Arrow IPC attachment to plain row
    // objects so the caller still gets JSON_ARRAY-shaped data.
    const arrowResult = await executor.query(
      query,
      processedParams,
      { disposition: "INLINE", format: "ARROW_STREAM" },
      signal,
    );
    if (!arrowResult?.attachment) {
      throw ExecutionError.missingData("ARROW_STREAM attachment");
    }
    const rows = decodeArrowAttachmentToRows(arrowResult.attachment);
    return makeResultMessage(rows, {
      status: arrowResult.status,
      statement_id: arrowResult.statement_id,
    });
  }

  /**
   * ARROW_STREAM path. Tries `INLINE + ARROW_STREAM` first; on a
   * structured `needs-json` rejection (warehouse refuses ARROW_STREAM
   * under INLINE), falls back to `EXTERNAL_LINKS + ARROW_STREAM`. When
   * INLINE succeeds with an Arrow attachment, the decoded bytes go
   * through `inlineArrowStash` and the client fetches them via
   * `/arrow-result/inline-<uuid>` — never the SSE channel.
   *
   * Failure modes surfaced to the caller:
   * - Unrelated warehouse errors (not classified as `needs-json`)
   *   propagate untouched.
   * - `ExecutionError.canceled()` if the client disconnects between
   *   the INLINE response and the stash put.
   * - `ExecutionError.stashExhausted()` if both stash pools are full —
   *   we never silently re-run on EXTERNAL_LINKS because that would
   *   double-bill the warehouse and risk a divergent result for
   *   non-deterministic SQL.
   */
  private async _executeArrowStreamPath(
    executor: AnalyticsPlugin,
    query: string,
    processedParams:
      | Record<string, SQLTypeMarker | null | undefined>
      | undefined,
    stashUserKey: string,
    signal?: AbortSignal,
  ): Promise<AnalyticsSseMessage> {
    try {
      const result = await executor.query(
        query,
        processedParams,
        { disposition: "INLINE", format: "ARROW_STREAM" },
        signal,
      );
      if (result?.attachment) {
        return this._stashAndEmitInline(result, stashUserKey, signal);
      }
      // INLINE succeeded but the warehouse returned no Arrow attachment
      // (rare: inline `data_array` under ARROW_STREAM). An ARROW_STREAM
      // caller's client decodes the `/arrow-result` bytes into a
      // TypedArrowTable, so emitting a `result` row message here would
      // break that contract. Fall through to the EXTERNAL_LINKS path
      // below to obtain a fetchable Arrow statement instead.
      logger.warn(
        "ARROW_STREAM INLINE returned no attachment; falling back to EXTERNAL_LINKS",
      );
    } catch (err: unknown) {
      // If the request was aborted, do not retry — the signal is dead and
      // a second statement would be billed but never read.
      if (signal?.aborted) throw err;
      if (_classifyInlineRejection(err) !== "needs-json") throw err;

      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        "ARROW_STREAM INLINE rejected by warehouse, falling back to EXTERNAL_LINKS: %s",
        msg,
      );
    }

    const result = await executor.query(
      query,
      processedParams,
      { disposition: "EXTERNAL_LINKS", format: "ARROW_STREAM" },
      signal,
    );
    return makeArrowMessage(result.statement_id, { status: result.status });
  }

  /**
   * Decode an INLINE Arrow attachment, push it onto the stash, and
   * return the `arrow` SSE message that references the synthetic id.
   * Pulled out of `_executeArrowStreamPath` so the cap / overflow /
   * exhaustion logic lives in one place.
   */
  private _stashAndEmitInline(
    result: { attachment: string; status?: unknown },
    stashUserKey: string,
    signal?: AbortSignal,
  ): AnalyticsSseMessage {
    // If the client has already disconnected, the SSE write would be
    // dropped anyway — skip the decode + stash so the bytes do not
    // linger in memory until TTL eviction.
    if (signal?.aborted) {
      throw ExecutionError.canceled();
    }
    const decoded = Buffer.from(result.attachment, "base64");
    const stashBytes = new Uint8Array(
      decoded.buffer,
      decoded.byteOffset,
      decoded.byteLength,
    );
    const putResult = this.inlineArrowStash.put(stashUserKey, stashBytes);
    if (putResult === null) {
      // Both regular and overflow pools are at cap. Throw with a clear
      // signal rather than re-running the same statement on
      // EXTERNAL_LINKS: the bytes we already decoded are gone, the
      // warehouse has been billed, and a second execution could return
      // a divergent result for non-deterministic SQL.
      this._recordStashOutcome("exhausted", stashBytes.byteLength);
      logger.warn(
        "Inline Arrow stash exhausted (regular + overflow); rejecting",
      );
      throw ExecutionError.stashExhausted();
    }
    this._recordStashOutcome(putResult.pool, stashBytes.byteLength);
    return makeArrowMessage(putResult.id, { status: result.status });
  }

  /**
   * Execute a SQL query using the current execution context.
   *
   * When called directly: uses service principal credentials.
   * When called via asUser(req).query(...): uses user's credentials.
   *
   * @example
   * ```typescript
   * // Service principal execution
   * const result = await analytics.query("SELECT * FROM table")
   *
   * // User context execution (in route handler)
   * const result = await this.asUser(req).query("SELECT * FROM table")
   * ```
   */
  async query(
    query: string,
    parameters?: Record<string, SQLTypeMarker | null | undefined>,
    formatParameters?: Record<string, any>,
    signal?: AbortSignal,
  ): Promise<any> {
    const workspaceClient = getWorkspaceClient();
    const warehouseId = await getWarehouseId();

    const { statement, parameters: sqlParameters } =
      this.queryProcessor.convertToSQLParameters(query, parameters);

    const response = await this.SQLClient.executeStatement(
      workspaceClient,
      {
        statement,
        warehouse_id: warehouseId,
        parameters: sqlParameters,
        ...formatParameters,
      },
      signal,
    );

    return response.result;
  }

  /**
   * Get Arrow-formatted data for a completed query job.
   */
  protected async getArrowData(
    workspaceClient: WorkspaceClient,
    jobId: string,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof this.SQLClient.getArrowData>> {
    return await this.SQLClient.getArrowData(workspaceClient, jobId, signal);
  }

  async shutdown(): Promise<void> {
    this.streamManager.abortAll();
  }

  private tools = {
    query: defineTool({
      description:
        "Execute a read-only SQL query against the Databricks SQL warehouse. Only SELECT, WITH, SHOW, EXPLAIN, and DESCRIBE statements are accepted; writes are rejected. Returns the query results as JSON.",
      schema: z.object({
        query: z
          .string()
          .describe(
            "The SQL query to execute. Must be a SELECT, WITH, SHOW, EXPLAIN, or DESCRIBE statement.",
          ),
      }),
      annotations: {
        effect: "read",
        requiresUserContext: true,
      },
      autoInheritable: true,
      execute: (args, signal) => {
        assertReadOnlySql(args.query);
        return this.query(args.query, undefined, undefined, signal);
      },
    }),
  };

  getAgentTools(): AgentToolDefinition[] {
    return toolsFromRegistry(this.tools);
  }

  async executeAgentTool(
    name: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return executeFromRegistry(this.tools, name, args, signal);
  }

  /**
   * Returns the plugin's tools as a keyed record of `ToolkitEntry` markers.
   * Called by the agents plugin (via `resolveToolkitFromProvider`) to spread
   * a filtered, renamed view of the plugin's tools into an agent's tool
   * index. Inside the function form of `AgentDefinition.tools`, callers
   * reach this method via `plugins.analytics.toolkit(opts)`.
   */
  toolkit(opts?: import("../../core/agent/types").ToolkitOptions) {
    return buildToolkitEntries(this.name, this.tools, opts);
  }

  /**
   * Returns the public exports for the analytics plugin.
   * Note: `asUser()` is automatically added by AppKit.
   */
  exports() {
    return {
      /**
       * Execute a SQL query using service principal credentials.
       */
      query: this.query,
    };
  }
}

/**
 * Hard caps on the server-side JSON_ARRAY fallback. The materializer
 * builds every row as a plain JS object on the Node main thread
 * (O(rows × cols) allocations), so a runaway result blocks the event
 * loop and pressures GC. We cap two ways — rows AND decoded bytes —
 * because either dimension can blow up independently (100k×1B rows is
 * fine, 10 rows × 10MB cells is not).
 */
const JSON_ARRAY_FALLBACK_MAX_ROWS = 100_000;
const JSON_ARRAY_FALLBACK_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Replacer used by the nested-value `JSON.stringify` path. Arrow IPC
 * carries column values whose JS representations include `bigint`
 * (which the spec'd `JSON.stringify` cannot serialize and throws on),
 * `Uint8Array` (binary buffers — would serialize as `{"0":...,"1":...}`
 * which is wrong), and `Date` (would lose timezone fidelity inside a
 * nested struct). Coerce each to a string form that matches what the
 * warehouse itself emits under native JSON_ARRAY.
 */
function nestedJsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  }
  if (value instanceof Date) return value.toISOString();
  return value;
}

/**
 * Render an `apache-arrow` Decimal cell to a fixed-point string. The JS
 * value is a `DecimalBigNum` whose `toString()` yields the *signed
 * unscaled* integer (e.g. `12345`, `-6789`); the decimal point is placed
 * `scale` digits from the right to match the warehouse's native
 * JSON_ARRAY rendering (`"123.45"`, `"-67.89"`).
 */
function formatDecimalCell(
  value: { toString(): string },
  scale: number,
): string {
  const unscaled = value.toString();
  if (scale <= 0) return unscaled;
  const negative = unscaled.startsWith("-");
  let digits = negative ? unscaled.slice(1) : unscaled;
  if (digits.length <= scale) digits = digits.padStart(scale + 1, "0");
  const point = digits.length - scale;
  const out = `${digits.slice(0, point)}.${digits.slice(point)}`;
  return negative ? `-${out}` : out;
}

/**
 * Render an `apache-arrow` Timestamp cell to the warehouse's native
 * JSON_ARRAY rendering, which is ISO-8601 with millisecond precision:
 * `yyyy-MM-ddTHH:mm:ss.SSSZ` for zoned TIMESTAMP / TIMESTAMP_LTZ, and the
 * same without the trailing `Z` for TIMESTAMP_NTZ. This is exactly
 * `Date#toISOString()` (drop the `Z` when the column carries no timezone).
 *
 * `arrow-js` normalizes every Timestamp unit to epoch **milliseconds** at
 * `.get()` (a MICROSECOND column returns ms, not micros); the warehouse
 * also truncates JSON_ARRAY timestamps to ms, so the two agree. Verified
 * against a dogfood serverless warehouse: `2024-06-13T01:02:03.500Z`,
 * `2024-06-13T01:02:03.000Z`, and NTZ `2024-01-02T03:04:05.000`.
 */
function formatTimestampCell(epochMs: number, hasTimezone: boolean): string {
  const iso = new Date(epochMs).toISOString();
  return hasTimezone ? iso : iso.slice(0, -1);
}

/**
 * Render an `apache-arrow` Date cell to `yyyy-MM-dd` (UTC) to match the
 * warehouse's native JSON_ARRAY rendering. `arrow-js` normalizes Date
 * columns to epoch milliseconds at UTC midnight on `.get()`.
 */
function formatDateCell(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * Parse a STRING cell that looks like JSON (`{`/`[` prefixed) into an
 * object/array, mirroring `SQLWarehouseConnector._transformDataArray` so
 * the JSON_ARRAY fallback produces the same nested shape the native
 * JSON_ARRAY path does. Non-JSON strings (and parse failures) pass
 * through unchanged.
 */
function maybeParseJsonString(value: string): unknown {
  if (value && (value[0] === "{" || value[0] === "[")) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

/**
 * Decode a base64 Arrow IPC attachment to plain row objects.
 *
 * Used by the JSON_ARRAY fallback path when a warehouse refuses
 * `JSON_ARRAY + INLINE` and we have to satisfy the request via
 * `ARROW_STREAM + INLINE` — the bytes come back as Arrow IPC but the
 * caller's contract is JSON-shaped rows, so we convert server-side.
 *
 * Shape rules (chosen to match what the warehouse emits natively under
 * JSON_ARRAY, so callers cannot tell which path served their query):
 * - **Scalars (number / bigint / boolean)**: stringified. JSON_ARRAY
 *   wire format emits everything in `result.data_array` as strings;
 *   bigint stringification is also necessary for JSON-serializability.
 * - **Strings / Date / Uint8Array**: stringified consistently —
 *   `Date` to ISO string, `Uint8Array` to base64.
 * - **Nested (List / Struct / Map)**: `JSON.stringify` with the
 *   `nestedJsonReplacer` so nested bigints / Dates / binary buffers
 *   serialize sanely instead of throwing or producing object-as-map
 *   output. Apache-arrow's typed values expose `toJSON()` so the
 *   resulting string matches what the warehouse would have emitted.
 */
function decodeArrowAttachmentToRows(
  attachment: string,
): Record<string, unknown>[] {
  const decoded = Buffer.from(attachment, "base64");
  if (decoded.byteLength > JSON_ARRAY_FALLBACK_MAX_BYTES) {
    throw ExecutionError.statementFailed(
      `Result attachment is ${decoded.byteLength} bytes; JSON_ARRAY fallback materializer caps at ${JSON_ARRAY_FALLBACK_MAX_BYTES} bytes. Re-issue the query with format="ARROW_STREAM" to stream the full result.`,
      "RESULT_TOO_LARGE_FOR_JSON_FALLBACK",
      "Result too large for JSON format. Re-run with ARROW_STREAM format.",
    );
  }
  const table = tableFromIPC(
    new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength),
  );
  if (table.numRows > JSON_ARRAY_FALLBACK_MAX_ROWS) {
    throw ExecutionError.statementFailed(
      `Result has ${table.numRows} rows; JSON_ARRAY fallback materializer caps at ${JSON_ARRAY_FALLBACK_MAX_ROWS}. Re-issue the query with format="ARROW_STREAM" to stream the full result.`,
      "RESULT_TOO_LARGE_FOR_JSON_FALLBACK",
      `Result too large for JSON format (over ${JSON_ARRAY_FALLBACK_MAX_ROWS} rows). Re-run with ARROW_STREAM format.`,
    );
  }
  // Resolve the child vectors once. `table.getChild(name)` walks the
  // schema fields on every call; without this hoist we'd pay that cost
  // O(rows × cols) times. At 100k × 50 columns that's millions of
  // redundant lookups on the event loop.
  const columns = table.schema.fields.map(
    (f) => [f.name, table.getChild(f.name), f.type] as const,
  );
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < table.numRows; i++) {
    const row: Record<string, unknown> = {};
    for (const [name, col, type] of columns) {
      const v = col?.get(i);
      if (v == null) {
        row[name] = null;
        continue;
      }
      // Branch on the Arrow field type first: several Databricks types
      // decode to JS values whose default stringification does NOT match
      // the warehouse's native JSON_ARRAY rendering. Without these the
      // fallback silently diverges from the direct JSON_ARRAY path
      // (decimals lose scale, temporals come back as raw epoch numbers).
      switch (type.typeId) {
        case Type.Decimal:
          row[name] = formatDecimalCell(
            v as { toString(): string },
            (type as DataType & { scale: number }).scale,
          );
          continue;
        case Type.Timestamp:
          row[name] = formatTimestampCell(
            Number(v),
            (type as DataType & { timezone?: string | null }).timezone != null,
          );
          continue;
        case Type.Date:
          row[name] = formatDateCell(Number(v));
          continue;
      }
      if (
        typeof v === "number" ||
        typeof v === "bigint" ||
        typeof v === "boolean"
      ) {
        row[name] = String(v);
      } else if (typeof v === "string") {
        // Match `_transformDataArray`: STRING columns holding JSON are
        // parsed into objects/arrays so both paths yield the same shape.
        row[name] = maybeParseJsonString(v);
      } else if (v instanceof Date) {
        row[name] = v.toISOString();
      } else if (v instanceof Uint8Array) {
        row[name] = Buffer.from(v).toString("base64");
      } else {
        // Nested types (List, Struct, Map). Use the replacer so nested
        // bigint / Date / Uint8Array values serialize predictably —
        // bare `JSON.stringify` throws on bigint and emits broken
        // shapes for binary buffers.
        row[name] = JSON.stringify(v, nestedJsonReplacer);
      }
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Classify a warehouse rejection of an INLINE statement.
 *
 * Two distinct rejection modes are observed in the wild:
 *
 * - **needs-arrow**: warehouse refuses `JSON_ARRAY + INLINE`, only accepts
 *   `ARROW_STREAM + INLINE`. Example message:
 *   `"Inline disposition only supports ARROW_STREAM format."`
 *   Action: retry as `ARROW_STREAM + INLINE` and decode server-side.
 *
 * - **needs-json**: warehouse refuses `ARROW_STREAM + INLINE`, only accepts
 *   `JSON_ARRAY + INLINE`. Examples:
 *   `"The format field must be JSON_ARRAY when the disposition field is INLINE."`
 *   `"ARROW_STREAM not supported with INLINE disposition"`
 *   `"ExternalLinks disposition is not yet implemented."` (same family —
 *   the warehouse rejected the disposition/format combo we sent).
 *   Action: retry as `ARROW_STREAM + EXTERNAL_LINKS`.
 *
 * The structured `errorCode` (INVALID_PARAMETER_VALUE / NOT_IMPLEMENTED)
 * gates the classification so unrelated SQL errors don't trigger a retry.
 * Message matching is case-insensitive — warehouses are inconsistent about
 * casing of "Inline"/"INLINE".
 */
type InlineRejection = "needs-arrow" | "needs-json" | null;

function _classifyInlineRejection(err: unknown): InlineRejection {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

  const structuredCode =
    err instanceof ExecutionError ? err.errorCode : undefined;
  const hasCode =
    structuredCode === "INVALID_PARAMETER_VALUE" ||
    structuredCode === "NOT_IMPLEMENTED" ||
    lower.includes("invalid_parameter_value") ||
    lower.includes("not_implemented");
  if (!hasCode) return null;

  // Must mention the inline disposition to count as a disposition-rejection.
  if (!lower.includes("inline")) return null;

  // "needs-arrow": warehouse only supports ARROW_STREAM for INLINE.
  if (
    /only supports\s+arrow_stream/i.test(msg) ||
    /must be\s+arrow_stream/i.test(msg)
  ) {
    return "needs-arrow";
  }

  // "needs-json": warehouse only supports JSON_ARRAY for INLINE.
  if (
    /only supports\s+json_array/i.test(msg) ||
    /must be\s+json_array/i.test(msg) ||
    /arrow_stream\s+(is\s+|was\s+)?not\s+supported/i.test(msg)
  ) {
    return "needs-json";
  }

  return null;
}

/**
 * @internal
 */
export const analytics = toPlugin(AnalyticsPlugin);
