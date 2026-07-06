import type express from "express";
import {
  type AgentToolDefinition,
  type AnalyticsSseMessage,
  type IAppRouter,
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
import { queryDefaults } from "./defaults";
import manifest from "./manifest.json";
import { QueryProcessor } from "./query";
import { deliverArrowBytes, deliverJsonResult } from "./result-delivery";
import {
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
    this.route<AnalyticsQueryResponse>(router, {
      name: "query",
      method: "post",
      path: "/query/:query_key",
      handler: async (req: express.Request, res: express.Response) => {
        await this._handleQueryRoute(req, res);
      },
    });

    // Column-names fallback for very wide Arrow schemas whose names don't fit
    // in the `X-Appkit-Arrow-Columns` response header (see
    // `_setArrowColumnsHeader`). The client hits this with the statement id
    // from `X-Appkit-Arrow-Columns-Ref`.
    this.route(router, {
      name: "arrow-columns",
      method: "get",
      path: "/columns/:statementId",
      handler: async (req: express.Request, res: express.Response) => {
        await this._handleColumnsRoute(req, res);
      },
    });
  }

  /**
   * Column-names fallback endpoint. Re-derives the real column names from the
   * statement's result manifest (stateless — no server cache), for the client
   * to relabel a positional Arrow schema when the names were too large for the
   * response header.
   */
  async _handleColumnsRoute(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const { statementId } = req.params;
    const columns = await this._resolveColumnNames(req, statementId);
    if (columns && columns.length > 0) {
      res.setHeader("Cache-Control", "no-store");
      res.json({ columns });
      return;
    }
    res.status(404).json({
      error: "Column names unavailable",
      plugin: this.name,
    });
  }

  /**
   * Resolve a statement's real column names, trying the user's identity first
   * (required for `.obo.sql` statements, which the service principal cannot
   * `getStatement`) then falling back to the service principal (for
   * SP-executed statements). Returns undefined if neither identity can read it,
   * so the client falls back to the raw positional Arrow schema names.
   */
  private async _resolveColumnNames(
    req: express.Request,
    statementId: string,
  ): Promise<string[] | undefined> {
    const attempts: Array<() => Promise<string[] | undefined>> = [
      () => this.asUser(req)._getColumnNames(statementId),
      () => this._getColumnNames(statementId),
    ];
    for (const attempt of attempts) {
      try {
        const columns = await attempt();
        if (columns && columns.length > 0) return columns;
      } catch (error) {
        logger.debug(
          "Arrow column-names lookup attempt failed for %s: %O",
          statementId,
          error,
        );
      }
    }
    return undefined;
  }

  /**
   * Fetch column names in the current execution context. Proxied by `asUser`,
   * so `getWorkspaceClient()` resolves to the user's client when invoked via
   * `this.asUser(req)` and the service principal's otherwise.
   */
  async _getColumnNames(statementId: string): Promise<string[] | undefined> {
    return this.SQLClient.getColumnNames(getWorkspaceClient(), statementId);
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

    // ARROW_STREAM streams the raw Arrow IPC bytes back as the HTTP response
    // body — no SSE, no server-side stash, no second /arrow-result request.
    // INLINE attachments are piped straight through (the bytes are already in
    // hand from executeStatement); a warehouse that refuses INLINE falls back
    // to EXTERNAL_LINKS and streams those chunks. JSON keeps the SSE path
    // below (it carries warehouse-readiness progress + cached rows).
    if (format === "ARROW_STREAM") {
      await this._handleArrowStreamQuery(req, res, query, isAsUser, parameters);
      return;
    }

    // get execution context - user-scoped if .obo.sql, otherwise service principal
    const executor = isAsUser ? this.asUser(req) : this;
    const executorKey = isAsUser ? this.resolveUserId(req) : "global";

    const hashedQuery = this.queryProcessor.hashQuery(query);

    const cacheConfig = {
      ...queryDefaults.cache,
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
              // JSON_ARRAY path: tries INLINE + JSON_ARRAY and, if the
              // warehouse only accepts ARROW_STREAM for INLINE, retries as
              // ARROW_STREAM and decodes server-side — returning the SSE
              // `result` message with plain rows. (ARROW_STREAM requests are
              // handled earlier via `_handleArrowStreamQuery`.)
              return await self._executeJsonArrayPath(
                executor,
                query,
                processedParams,
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
          // RESULT_TOO_LARGE_FOR_JSON_FALLBACK) and sanitized `clientMessage`
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
   * JSON_ARRAY SSE path. Delegates the disposition/format fallback to
   * {@link deliverJsonResult} (INLINE JSON_ARRAY → on `needs-arrow-inline`,
   * INLINE ARROW_STREAM decoded to rows) and wraps the rows in a `result`
   * message. External links are never used for the JSON fallback.
   */
  private async _executeJsonArrayPath(
    executor: AnalyticsPlugin,
    query: string,
    processedParams:
      | Record<string, SQLTypeMarker | null | undefined>
      | undefined,
    signal?: AbortSignal,
  ): Promise<AnalyticsSseMessage> {
    const result = await deliverJsonResult(
      executor,
      query,
      processedParams,
      signal,
    );
    return makeResultMessage(result.data, {
      status: result.status,
      statement_id: result.statement_id,
    });
  }

  /**
   * Attach the real column names so the client can relabel the positional
   * Arrow schema (Databricks encodes ARROW_STREAM columns as col_0, …).
   *
   * Small schemas ride `X-Appkit-Arrow-Columns` directly. A very wide schema
   * whose URL-encoded names would blow the HTTP header size limit instead
   * advertises the statement id in `X-Appkit-Arrow-Columns-Ref`, and the
   * client fetches the names from `GET /columns/:statementId`.
   */
  private _setArrowColumnsHeader(
    res: express.Response,
    columnsRef: { columnNames?: string[]; statementId?: string },
  ): void {
    const names = columnsRef.columnNames;
    if (!names || names.length === 0) return;

    const encoded = encodeURIComponent(JSON.stringify(names));
    if (encoded.length <= MAX_ARROW_COLUMNS_HEADER_BYTES) {
      res.setHeader("X-Appkit-Arrow-Columns", encoded);
      return;
    }
    if (columnsRef.statementId) {
      res.setHeader("X-Appkit-Arrow-Columns-Ref", columnsRef.statementId);
    } else {
      logger.warn(
        "Arrow column names exceed the header limit and no statement id is available for the fallback endpoint; client will fall back to the raw schema names",
      );
    }
  }

  /**
   * ARROW_STREAM query handler: stream the raw Arrow IPC bytes back as the
   * HTTP response body — no SSE, no server-side stash, no second
   * `/arrow-result` request.
   *
   * The first chunk is pulled before headers are sent so a failure still
   * yields a clean JSON error; once bytes are in flight a mid-stream failure
   * can only abort the socket. Warehouse readiness is awaited (no SSE
   * progress on this path) — a no-op for a warm warehouse, a blocking wait
   * on a cold start. Runs under the user's context for `.obo.sql` queries.
   */
  private async _handleArrowStreamQuery(
    req: express.Request,
    res: express.Response,
    query: string,
    isAsUser: boolean,
    parameters: IAnalyticsQueryRequest["parameters"],
  ): Promise<void> {
    const executor = isAsUser ? this.asUser(req) : this;
    const abortController = new AbortController();
    const onClose = () => abortController.abort();
    res.on("close", onClose);
    const signal = abortController.signal;

    // Fail-fast: bound the wait for the first byte (warehouse readiness +
    // execute + first chunk) so a stuck/overloaded warehouse returns a clear
    // 503 instead of hanging until the client gives up. Cleared once the
    // first chunk arrives — a legitimately long stream is never interrupted.
    const firstByteTimeoutMs =
      this.config.arrowFirstByteTimeoutMs ??
      DEFAULT_ARROW_FIRST_BYTE_TIMEOUT_MS;
    let timedOut = false;
    const failFast = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, firstByteTimeoutMs);

    try {
      const workspaceClient = getWorkspaceClient();
      const warehouseId = await getWarehouseId();
      const startupTimeoutMs =
        this.config.warehouseStartupTimeoutMs ??
        DEFAULT_WAREHOUSE_STARTUP_TIMEOUT_MS;
      const autoStart = this.config.autoStartWarehouse ?? true;

      await this.SQLClient.ensureWarehouseRunning(
        workspaceClient,
        warehouseId,
        {
          signal,
          timeoutMs: startupTimeoutMs,
          autoStart,
          // No SSE progress channel on the direct-binary path — readiness is
          // simply awaited.
          onStatus: () => {},
        },
      );

      const processedParams = await this.queryProcessor.processQueryParams(
        query,
        parameters,
      );

      // Populated by `deliverArrowBytes` from the result manifest before the
      // first chunk is yielded, so the header below carries the real names.
      const columnsRef: { columnNames?: string[]; statementId?: string } = {};
      const bytes = deliverArrowBytes(
        executor,
        this.SQLClient,
        query,
        processedParams,
        columnsRef,
        signal,
      );
      const first = await bytes.next();
      // First byte in hand — stop the fail-fast clock.
      clearTimeout(failFast);

      res.setHeader("Content-Type", "application/vnd.apache.arrow.stream");
      res.setHeader("Cache-Control", "no-store");
      this._setArrowColumnsHeader(res, columnsRef);

      if (!first.done) {
        await writeChunk(res, first.value);
        for await (const buf of bytes) {
          await writeChunk(res, buf);
        }
      }
      res.end();
    } catch (error) {
      clearTimeout(failFast);
      if (res.headersSent) {
        logger.error("Arrow query stream failed mid-flight: %O", error);
        res.destroy(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (timedOut) {
        logger.warn(
          "Arrow query timed out before first byte after %dms",
          firstByteTimeoutMs,
        );
        res.status(503).json({
          error:
            "The SQL warehouse is starting or overloaded and did not respond in time. Please retry.",
          errorCode: "WAREHOUSE_UNAVAILABLE",
          plugin: this.name,
        });
        return;
      }
      if (signal.aborted) {
        res.end();
        return;
      }
      logger.error("Arrow query error: %O", error);
      // Do not echo upstream / SDK error text — it can include statement
      // fragments and correlation ids. Keep the structured code so the
      // client can branch (e.g. RESULT_TOO_LARGE_FOR_JSON_FALLBACK,
      // ARROW_DELIVERY_UNSUPPORTED).
      const errorCode =
        error instanceof ExecutionError ? error.errorCode : undefined;
      res.status(500).json({
        // `clientMessage` is the sanitized, actionable text (e.g. "Re-run with
        // JSON_ARRAY" for ARROW_DELIVERY_UNSUPPORTED); it never carries raw
        // warehouse/SDK strings. Fall back to a generic message otherwise.
        error:
          error instanceof AppKitError
            ? error.clientMessage
            : "Unable to execute query",
        errorCode,
        plugin: this.name,
      });
    } finally {
      res.off("close", onClose);
    }
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
 * Write one chunk to the response honoring backpressure: if the socket
 * buffer is full (`res.write` returns false), wait for `drain` before
 * resolving so a slow client can't balloon Node's internal write queue and
 * defeat the constant-memory goal of streaming.
 *
 * @internal exported for unit testing the backpressure/disconnect behavior.
 */
export function writeChunk(
  res: express.Response,
  bytes: Uint8Array,
): Promise<void> {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (res.write(buf)) return Promise.resolve();
  // Backpressured: resolve on `drain`, but also settle on `close`/`error`. A
  // client that disconnects mid-backpressure never emits `drain` on the
  // destroyed socket, so waiting on `drain` alone would wedge this promise —
  // and with it the awaiting for-await loop and the upstream Arrow reader —
  // forever. Rejecting instead unwinds the stream so its `finally` can cancel
  // the reader.
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      res.off("error", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new DOMException("The response stream closed", "AbortError"));
    };
    res.once("drain", onDrain);
    res.once("close", onClose);
    res.once("error", onClose);
  });
}

/**
 * Fail-fast ceiling on the wait for the first Arrow byte (warehouse
 * readiness + execute + first chunk). Past this a stuck/overloaded warehouse
 * yields a clear 503 instead of hanging. Override per plugin via
 * `arrowFirstByteTimeoutMs`.
 */
const DEFAULT_ARROW_FIRST_BYTE_TIMEOUT_MS = 120_000;

/**
 * Byte ceiling for the `X-Appkit-Arrow-Columns` header value. Beyond this (a
 * very wide schema) the names are served via the `/columns/:statementId`
 * fallback endpoint instead of the header. Kept well under the common ~8 KiB
 * per-header limit.
 */
const MAX_ARROW_COLUMNS_HEADER_BYTES = 6000;

/**
 * @internal
 */
export const analytics = toPlugin(AnalyticsPlugin);
