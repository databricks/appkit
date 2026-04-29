import type { WorkspaceClient } from "@databricks/sdk-experimental";
import type express from "express";
import type {
  IAppRouter,
  PluginExecuteConfig,
  SQLTypeMarker,
  StreamExecutionSettings,
} from "shared";
import { SQLWarehouseConnector } from "../../connectors";
import { getWarehouseId, getWorkspaceClient } from "../../context";
import { AppKitError } from "../../errors";
import { createLogger } from "../../logging/logger";
import { Plugin, toPlugin } from "../../plugin";
import type { PluginManifest } from "../../registry";
import { queryDefaults } from "./defaults";
import manifest from "./manifest.json";
import {
  buildMetricSql,
  composeMetricCacheKey,
  loadMetricRegistry,
  validateMetricRequest,
} from "./metric";
import { QueryProcessor } from "./query";
import type {
  AnalyticsQueryResponse,
  IAnalyticsConfig,
  IAnalyticsQueryRequest,
  MetricRegistration,
} from "./types";

const logger = createLogger("analytics");

export class AnalyticsPlugin extends Plugin {
  /** Plugin manifest declaring metadata and resource requirements */
  static manifest = manifest as PluginManifest<"analytics">;

  protected static description = "Analytics plugin for data analysis";
  protected declare config: IAnalyticsConfig;

  // analytics services
  private SQLClient: SQLWarehouseConnector;
  private queryProcessor: QueryProcessor;

  /**
   * Metric-view registry loaded from `config/queries/metric.json` at server
   * startup. Keys are stable; values carry the FQN, lane, and known
   * measure/dimension names. Empty when no `metric.json` is present.
   */
  private metricRegistry: Record<string, MetricRegistration> = {};

  constructor(config: IAnalyticsConfig) {
    super(config);
    this.config = config;
    this.queryProcessor = new QueryProcessor();

    this.SQLClient = new SQLWarehouseConnector({
      timeout: config.timeout,
      telemetry: config.telemetry,
    });
  }

  /**
   * Eagerly load the metric registry. Failures are logged at warn level (not
   * thrown) so a malformed `metric.json` does not take down the whole app —
   * the route handler returns a clean 404 for unregistered keys regardless.
   */
  async setup(): Promise<void> {
    try {
      this.metricRegistry = await loadMetricRegistry();
    } catch (err) {
      logger.warn(
        "Failed to load metric registry: %s",
        err instanceof Error ? err.message : String(err),
      );
      this.metricRegistry = {};
    }
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

    this.route(router, {
      name: "metric",
      method: "post",
      path: "/metric/:key",
      handler: async (req: express.Request, res: express.Response) => {
        await this._handleMetricRoute(req, res);
      },
    });
  }

  /**
   * Handle Arrow data download requests.
   * When called via asUser(req), uses the user's Databricks credentials.
   */
  async _handleArrowRoute(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    try {
      const { jobId } = req.params;
      const workspaceClient = getWorkspaceClient();

      logger.debug("Processing Arrow job request for jobId=%s", jobId);

      const event = logger.event(req);
      event?.setComponent("analytics", "getArrowData").setContext("analytics", {
        job_id: jobId,
        plugin: this.name,
      });

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
      res.status(404).json({
        error: error instanceof Error ? error.message : "Arrow job not found",
        plugin: this.name,
      });
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
    const { parameters, format = "JSON" } = req.body as IAnalyticsQueryRequest;

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

    const queryParameters =
      format === "ARROW"
        ? {
            formatParameters: {
              disposition: "EXTERNAL_LINKS",
              format: "ARROW_STREAM",
            },
            type: "arrow",
          }
        : {
            type: "result",
          };

    const hashedQuery = this.queryProcessor.hashQuery(query);

    const defaultConfig: PluginExecuteConfig = {
      ...queryDefaults,
      cache: {
        ...queryDefaults.cache,
        cacheKey: [
          "analytics:query",
          query_key,
          JSON.stringify(parameters),
          JSON.stringify(format),
          hashedQuery,
          executorKey,
        ],
      },
    };

    const streamExecutionSettings: StreamExecutionSettings = {
      default: defaultConfig,
    };

    await executor.executeStream(
      res,
      async (signal) => {
        const processedParams = await this.queryProcessor.processQueryParams(
          query,
          parameters,
        );

        const result = await executor.query(
          query,
          processedParams,
          queryParameters.formatParameters,
          signal,
        );

        return { type: queryParameters.type, ...result };
      },
      streamExecutionSettings,
      executorKey,
    );
  }

  /**
   * Handle a metric-view query against `POST /api/analytics/metric/:key`.
   *
   * Phase 1 surface:
   *  - body validated by zod (rejects unknown measures when the registry
   *    has build-time metadata)
   *  - SQL constructed as `SELECT MEASURE(<m>) FROM <fqn> [LIMIT n]`
   *  - response uses the same SSE envelope as the existing query route
   *  - reuses the interceptor chain via `executeStream()` (telemetry,
   *    timeout, retry, cache)
   *
   * OBO dispatch is implemented but only the SP lane has callers in Phase 1.
   * Phase 4 finalizes OBO + cache key composition.
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

    const registration = this.metricRegistry[key];
    if (!registration) {
      res.status(404).json({ error: `Metric "${key}" not registered` });
      return;
    }

    let request: ReturnType<typeof validateMetricRequest>;
    try {
      request = validateMetricRequest(registration, req.body ?? {});
    } catch (err) {
      if (err instanceof AppKitError) {
        res.status(err.statusCode).json({
          error: err.message,
          code: err.code,
        });
        return;
      }
      // Validator only throws ValidationError, but be defensive.
      res.status(400).json({
        error: err instanceof Error ? err.message : "Invalid request body",
      });
      return;
    }

    const format = request.format ?? "JSON";
    const isAsUser = registration.lane === "obo";
    const executor = isAsUser ? this.asUser(req) : this;
    const executorKey = isAsUser ? this.resolveUserId(req) : "sp";

    const queryParameters =
      format === "ARROW"
        ? {
            formatParameters: {
              disposition: "EXTERNAL_LINKS",
              format: "ARROW_STREAM",
            },
            type: "arrow",
          }
        : { type: "result" };

    const cacheKey = composeMetricCacheKey({
      metricKey: key,
      measures: request.measures,
      dimensions: request.dimensions,
      timeGrain: request.timeGrain,
      format,
      executorKey,
      limit: request.limit,
    });

    const defaultConfig: PluginExecuteConfig = {
      ...queryDefaults,
      cache: {
        ...queryDefaults.cache,
        cacheKey,
      },
    };

    const streamExecutionSettings: StreamExecutionSettings = {
      default: defaultConfig,
    };

    await executor.executeStream(
      res,
      async (signal) => {
        const { statement } = buildMetricSql(registration, request);
        const result = await executor.query(
          statement,
          undefined,
          queryParameters.formatParameters,
          signal,
        );
        return { type: queryParameters.type, ...result };
      },
      streamExecutionSettings,
      executorKey,
    );
  }

  /**
   * Test-only seam: populate the metric registry without going through
   * `setup()` (which reads `config/queries/metric.json` from disk). Tests
   * exercise the route handler directly with synthetic registrations.
   *
   * @internal
   */
  _setMetricRegistryForTesting(
    registry: Record<string, MetricRegistration>,
  ): void {
    this.metricRegistry = registry;
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
 * @internal
 */
export const analytics = toPlugin(AnalyticsPlugin);
