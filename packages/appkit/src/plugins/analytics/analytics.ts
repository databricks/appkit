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
import {
  buildMetricSql,
  composeMetricCacheKey,
  deriveMetricExecutorKey,
  loadMetricRegistry,
  validateMetricRequest,
} from "./metric";
import { QueryProcessor } from "./query";
import {
  type ArrowCapability,
  deliverArrowBytes,
  deliverJsonResult,
  type QueryExecutor,
} from "./result-delivery";
import {
  type AnalyticsQueryResponse,
  type AnalyticsStreamMessage,
  type IAnalyticsConfig,
  type IAnalyticsQueryRequest,
  type MetricRegistration,
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
   * In-process memo of which arrow delivery mode each warehouse supports
   * (keyed by warehouse id). A standard warehouse rejects `INLINE+ARROW_STREAM`
   * on every query, so once learned we skip that doomed probe; Reyden stays
   * `"inline"`. Capability is a property of the warehouse, not the user, so it
   * is not user-scoped. Bounded by the number of distinct warehouses a process
   * talks to (effectively one).
   */
  private _arrowCapability = new Map<string, ArrowCapability>();

  /**
   * Metric-view registry parsed from `config/queries/metric-views.json`, keyed
   * by metric key. Loaded lazily on the first `/metric/:key` request and
   * memoized (see {@link _getMetricRegistry}). Empty when no config is present
   * — the metric-view path stays dormant until an app opts in.
   */
  private metricRegistry: Record<string, MetricRegistration> | null = null;

  /**
   * Latched error from the most recent {@link loadMetricRegistry} attempt.
   * `null` means the registry loaded cleanly (or `metric-views.json` was absent
   * — also fine; metric views are opt-in). When non-null, every `/metric/:key`
   * request returns 503 `METRIC_REGISTRY_LOAD_FAILED` so a broken config
   * (unreadable file, invalid JSON, schema violation) surfaces as a clear
   * server status rather than masquerading as a 404 for every key. The full
   * reason goes to telemetry only.
   */
  private metricRegistryLoadError: string | null = null;

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

    // Metric-view route. Registered parallel to `/query`; measures a
    // registered UC Metric View over the same SSE envelope. Dormant until
    // `config/queries/metric-views.json` exists (no config → empty registry →
    // 404, nothing executes).
    this.route(router, {
      name: "metric",
      method: "post",
      path: "/metric/:key",
      handler: async (req: express.Request, res: express.Response) => {
        await this._handleMetricRoute(req, res);
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
      await this._handleArrowStreamQuery(
        req,
        res,
        query_key,
        query,
        isAsUser,
        parameters,
      );
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
   * Lazily load and memoize the metric registry from
   * `config/queries/metric-views.json`.
   *
   * A malformed config latches `metricRegistryLoadError` and yields an empty
   * registry so the route can return a 503 (distinguishing a broken deployment
   * from an unknown key, which is a 404). Loading is deferred to the first
   * `/metric/:key` request rather than the constructor so apps that never adopt
   * metric views pay no parse cost and a config error can't break plugin
   * construction.
   */
  private _getMetricRegistry(): Record<string, MetricRegistration> {
    if (this.metricRegistry === null) {
      try {
        this.metricRegistry = loadMetricRegistry();
        this.metricRegistryLoadError = null;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.warn("Failed to load metric registry: %s", reason);
        this.metricRegistry = {};
        this.metricRegistryLoadError = reason;
      }
    }
    return this.metricRegistry;
  }

  /**
   * Handle metric-view execution requests (`POST /api/analytics/metric/:key`).
   *
   * Mirrors {@link _handleQueryRoute}'s JSON SSE path: the outer
   * `executeStream` disables cache/retry and streams warehouse-readiness
   * (`warehouse_status`) events, then the inner `execute` builds the metric SQL
   * and delivers rows through {@link deliverJsonResult} as a `result` message.
   * The `originalError` re-throw discipline preserves each error's structured
   * `errorCode`/`clientMessage` for the SSE error payload.
   *
   * Lane dispatch is driven by the registration: an SP-lane metric runs as the
   * app service principal (shared cache); an OBO-lane metric runs
   * on-behalf-of the requesting user via `asUser(req)` (per-user cache keyed by
   * a hash of the user identity). The executor + key are computed inside a
   * try so a missing/whitespace OBO identity lands on the canonical 401 path.
   */
  async _handleMetricRoute(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const { key } = req.params;

    logger.debug(req, "Executing metric: %s", key);

    const event = logger.event(req);
    event?.setComponent("analytics", "executeMetric").setContext("analytics", {
      metric_key: key,
      plugin: this.name,
    });

    if (!key) {
      res.status(400).json({ error: "metric key is required" });
      return;
    }

    const registry = this._getMetricRegistry();

    // Surface a registry-load failure on the route. Without this, a malformed
    // metric-views.json would yield 404 for every key — identical to "key
    // never registered" — and hide the deployment error. Full reason →
    // telemetry only.
    if (this.metricRegistryLoadError !== null) {
      event?.setContext("analytics", {
        metric_registry_load_error: this.metricRegistryLoadError,
      });
      res.status(503).json({
        error: "Metric registry not available",
        code: "METRIC_REGISTRY_LOAD_FAILED",
      });
      return;
    }

    const registration = registry[key];
    if (!registration) {
      // Don't echo the user-supplied `key` back in the public response —
      // confirming "metric X is not registered" lets a probe enumerate keys by
      // elimination. The 404 status stays (useful for tooling); the body is
      // generic and detail goes to telemetry only.
      event?.setContext("analytics", { unknown_metric_key: key });
      res.status(404).json({ error: "Metric not found" });
      return;
    }

    // Validate the body on the canonical error path. `validateMetricRequest`
    // throws a `ValidationError` (400) whose message names only field paths,
    // never raw values.
    let request: ReturnType<typeof validateMetricRequest>;
    try {
      request = validateMetricRequest(req.body ?? {});
    } catch (err) {
      if (err instanceof AppKitError) {
        res.status(err.statusCode).json({ error: err.message, code: err.code });
        return;
      }
      event?.setContext("analytics", {
        unexpected_error: err instanceof Error ? err.message : String(err),
        metric_key: key,
      });
      logger.warn(
        req,
        "Unexpected throw during metric request validation for %s: %s",
        key,
        err instanceof Error ? err.message : String(err),
      );
      res.status(400).json({ error: "Invalid request body" });
      return;
    }

    // Lane dispatch. The lane comes from the registration (the entry's
    // `executor` in metric-views.json), NOT a URL segment or `.obo.sql`
    // filename: an OBO-lane metric runs on-behalf-of the requesting user
    // (per-user cache via `asUser(req)`), an SP-lane metric as the app service
    // principal (shared cache). Compute the executor + key INSIDE a try (as
    // `_handleQueryRoute` does) so `asUser(req)`/`resolveUserId(req)` and
    // `deriveMetricExecutorKey`'s missing-identity throw land on the canonical
    // 401 envelope instead of surfacing as an uncaught 500 out of the stream.
    let executor: AnalyticsPlugin;
    let executorKey: string;
    try {
      const isObo = registration.lane === "obo";
      executor = isObo ? this.asUser(req) : this;
      executorKey = deriveMetricExecutorKey({
        lane: registration.lane,
        userIdentity: isObo ? this.resolveUserId(req) : undefined,
      });
    } catch (err) {
      if (err instanceof AppKitError) {
        res.status(err.statusCode).json({ error: err.message, code: err.code });
        return;
      }
      throw err;
    }

    // Cache key. Composed over the canonicalized args (sorted measures/
    // dimensions, stable-sorted predicates, grain, timeDimension, limit) plus
    // the `executorKey` — `"sp"` shares the cache across all users, a per-user
    // identity hash isolates OBO callers. Delivery is JSON-only in v1 (the
    // route always routes through `_executeJsonArrayPath`), so the key salts on
    // a stable "JSON_ARRAY" constant rather than `request.format`: two calls
    // that deliver identically must not fork the cache on an unused format
    // field.
    const cacheConfig = {
      ...queryDefaults.cache,
      cacheKey: composeMetricCacheKey({
        metricKey: key,
        measures: request.measures,
        dimensions: request.dimensions,
        timeGrain: request.timeGrain,
        timeDimension: request.timeDimension,
        filter: request.filter,
        format: "JSON_ARRAY",
        executorKey,
        limit: request.limit,
      }),
    };

    // Cache/retry/timeout scoped to the SQL execution itself (inner `execute`)
    // so the warehouse-readiness phase isn't retried and the generator value
    // never leaks into the cache.
    const sqlConfig: PluginExecuteConfig = {
      ...queryDefaults,
      cache: cacheConfig,
    };

    // Outer stream: no cache/retry — `executeStream` would otherwise wrap the
    // generator factory and cache the generator object itself. Telemetry +
    // trace context still apply.
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
        // dropping the rich fields (`errorCode`, `clientMessage`). Capture the
        // original here so we can re-throw it intact — the SSE error path
        // (`StreamManager`) reads `errorCode`/`clientMessage` off it.
        let originalError: unknown;
        const sqlResult = await executor.execute(
          async (sig) => {
            try {
              const { statement, parameters } = buildMetricSql(
                registration,
                request,
              );
              const processedParams =
                await self.queryProcessor.processQueryParams(
                  statement,
                  Object.keys(parameters).length > 0 ? parameters : undefined,
                );
              // Reuse the query route's JSON delivery: INLINE JSON_ARRAY with
              // an ARROW_STREAM-inline fallback, returning plain rows in a
              // `result` message — byte-identical envelope to `/query`.
              return await self._executeJsonArrayPath(
                executor,
                statement,
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
          // Re-throw the original error so its structured `errorCode` and
          // sanitized `clientMessage` survive to the SSE error payload. Fall
          // back to a generic statement failure only if it wasn't an
          // AppKitError.
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
    query_key: string,
    query: string,
    isAsUser: boolean,
    parameters: IAnalyticsQueryRequest["parameters"],
  ): Promise<void> {
    const executor = isAsUser ? this.asUser(req) : this;
    const executorKey = isAsUser ? this.resolveUserId(req) : "global";
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
      // Run warehouse readiness in the SAME identity context as the query:
      // for `.obo.sql`, `executor` is the `asUser(req)` proxy, so
      // `getWorkspaceClient()` inside resolves to the user's client (matching
      // the SSE path). Calling it bare here would auto-start the warehouse as
      // the service principal even for OBO requests.
      await executor._ensureArrowWarehouseReady(signal);

      const processedParams = await this.queryProcessor.processQueryParams(
        query,
        parameters,
      );

      const warehouseId = await getWarehouseId();

      // Populated by `deliverArrowBytes` from the result manifest before the
      // first chunk is yielded, so the header below carries the real names.
      const columnsRef: { columnNames?: string[]; statementId?: string } = {};
      const bytes = deliverArrowBytes(
        // Wrap the executor so the INLINE attempt runs through the interceptor
        // chain (cache + retry), matching the JSON path. Only inline attachments
        // are cached; EXTERNAL_LINKS carry expiring pre-signed URLs and are
        // never cached (see `_arrowCachingExecutor`).
        this._arrowCachingExecutor(
          executor,
          query_key,
          query,
          parameters,
          executorKey,
        ),
        this.SQLClient,
        query,
        processedParams,
        columnsRef,
        signal,
        {
          // Skip the doomed INLINE probe on a warehouse already known to need
          // EXTERNAL_LINKS; remember the resolved mode for next time.
          capabilityHint: this._arrowCapability.get(warehouseId),
          onCapabilityResolved: (capability) =>
            this._arrowCapability.set(warehouseId, capability),
        },
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
      // Fail-fast timeout: the warehouse never produced a first byte. This also
      // aborts the signal, so it must be handled before the generic
      // `signal.aborted` branch below. Headers aren't sent yet (we time out
      // before the first chunk), so a clean 503 is still possible.
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
      // Client disconnect / unmount aborts the signal (see `onClose`). That's
      // routine UI behavior, not a server error — tear down quietly whether it
      // fires before or after headers. Checked before the headersSent branch so
      // a mid-stream disconnect doesn't spam ERROR logs / alerting.
      if (signal.aborted) {
        if (res.headersSent) res.destroy();
        else res.end();
        return;
      }
      if (res.headersSent) {
        logger.error("Arrow query stream failed mid-flight: %O", error);
        res.destroy(error instanceof Error ? error : new Error(String(error)));
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
   * Await SQL warehouse readiness for the direct-binary Arrow path. There is no
   * SSE progress channel here — readiness is simply awaited, bounded by the
   * caller's abort signal / fail-fast timeout. Invoked via the request executor
   * (`asUser(req)` for `.obo.sql`) so `getWorkspaceClient()` resolves in the
   * correct identity context rather than defaulting to the service principal.
   */
  async _ensureArrowWarehouseReady(signal: AbortSignal): Promise<void> {
    const workspaceClient = getWorkspaceClient();
    const warehouseId = await getWarehouseId();
    const startupTimeoutMs =
      this.config.warehouseStartupTimeoutMs ??
      DEFAULT_WAREHOUSE_STARTUP_TIMEOUT_MS;
    const autoStart = this.config.autoStartWarehouse ?? true;
    await this.SQLClient.ensureWarehouseRunning(workspaceClient, warehouseId, {
      signal,
      timeoutMs: startupTimeoutMs,
      autoStart,
      onStatus: () => {},
    });
  }

  /**
   * Wrap an executor so the `INLINE + ARROW_STREAM` attempt is served from
   * (and populates) the same per-user TTL cache the JSON path uses — otherwise
   * every arrow chart render is a fresh warehouse execution, unlike its JSON
   * twin. Caching is deliberately scoped to inline attachments:
   *
   * - INLINE results carry a bounded (<=25 MiB) base64 `attachment` with the
   *   same lifecycle as cached JSON rows — safe to cache.
   * - EXTERNAL_LINKS results carry short-lived pre-signed URLs that expire in
   *   minutes; caching them would serve dead links, so those pass through
   *   uncached (only the tiny link metadata would be cached anyway).
   *
   * Uses `this.cache.getOrExecute` directly rather than `this.execute()`
   * because `execute()` reduces a thrown error to `{ ok:false, message }`,
   * dropping the `errorCode` the capability fallback classifies on. The cache
   * re-throws `AppKitError`s intact and never caches a rejection, so the
   * INLINE→EXTERNAL_LINKS fallback still sees the structured rejection.
   */
  private _arrowCachingExecutor(
    executor: AnalyticsPlugin,
    query_key: string,
    query: string,
    parameters: IAnalyticsQueryRequest["parameters"],
    executorKey: string,
  ): QueryExecutor {
    const hashedQuery = this.queryProcessor.hashQuery(query);
    const cache = this.cache;
    const ttl = queryDefaults.cache?.ttl;
    return {
      query: (q, params, formatParameters, signal) => {
        // Only the inline-arrow attempt is cacheable — EXTERNAL_LINKS carry
        // short-lived pre-signed URLs, so those pass straight through.
        if (
          formatParameters.disposition !== "INLINE" ||
          formatParameters.format !== "ARROW_STREAM"
        ) {
          return executor.query(q, params, formatParameters, signal);
        }
        // On a standard warehouse this throws a capability rejection — the
        // cache never stores a rejection, so the fallback still sees the
        // structured error. On Reyden it returns a bounded (<=25 MiB)
        // attachment that caches like the JSON path's rows. The shared signal
        // dedupes concurrent renders (e.g. React StrictMode double-mount).
        return cache.getOrExecute(
          [
            "analytics:query:arrow",
            query_key,
            JSON.stringify(parameters),
            hashedQuery,
            executorKey,
          ],
          (sharedSignal) =>
            executor.query(q, params, formatParameters, sharedSignal ?? signal),
          executorKey,
          { ttl, callerSignal: signal },
        );
      },
    };
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
  // If the socket is already gone, `res.write` won't return true and the
  // `drain`/`close`/`error` events have already fired — so the promise below
  // would never settle, wedging the for-await loop and the upstream reader.
  // Reject up front instead.
  if (res.destroyed || res.writableEnded) {
    return Promise.reject(
      new DOMException("The response stream closed", "AbortError"),
    );
  }
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
