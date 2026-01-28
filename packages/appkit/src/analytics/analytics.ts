import type { WorkspaceClient } from "@databricks/sdk-experimental";
import type express from "express";
import type {
  IAppRouter,
  PluginExecuteConfig,
  SQLTypeMarker,
  StreamExecutionSettings,
} from "shared";
import { SQLWarehouseConnector } from "../connectors";
import {
  getCurrentUserId,
  getWarehouseId,
  getWorkspaceClient,
} from "../context";
import { createLogger } from "../logging/logger";
import { Plugin, toPlugin } from "../plugin";
import { queryDefaults } from "./defaults";
import { QueryProcessor } from "./query";
import type {
  AnalyticsQueryResponse,
  IAnalyticsConfig,
  IAnalyticsQueryRequest,
} from "./types";

const logger = createLogger("analytics");

export class AnalyticsPlugin extends Plugin {
  name = "analytics";
  protected _envVars: string[] = [];

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

  _injectRoutes(router: IAppRouter) {
    // Service principal endpoints
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
    // Cast to `this` for internal use - we need access to protected methods like executeStream
    const executor = (isAsUser ? this.asUser(req) : this) as this;
    const userKey = getCurrentUserId();
    const executorKey = isAsUser ? userKey : "global";

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

  async _shutdown(): Promise<void> {
    this.streamManager.abortAll();
  }
}

/**
 * @internal
 */
export const analytics = toPlugin<
  typeof AnalyticsPlugin,
  IAnalyticsConfig,
  "analytics"
>(AnalyticsPlugin, "analytics");
