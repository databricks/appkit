import type { WorkspaceClient } from "@databricks/sdk-experimental";
import type express from "express";
import type {
  IAppRequestWithBody,
  IAppRouter,
  PluginExecuteConfig,
  SQLTypeMarker,
  StreamExecutionSettings,
} from "shared";
import { z } from "zod";
import { SQLWarehouseConnector } from "../../connectors";
import { getWarehouseId, getWorkspaceClient } from "../../context";
import { createLogger } from "../../logging/logger";
import { Plugin, toPlugin } from "../../plugin";
import type { PluginManifest } from "../../registry";
import { queryDefaults } from "./defaults";
import manifest from "./manifest.json";
import { QueryProcessor } from "./query";
import type { IAnalyticsConfig } from "./types";

/**
 * Request body for POST /query/:query_key. Validated via Standard Schema
 * (Zod natively implements `~standard` from v3.24+). The `format` field
 * defaults to "JSON" via the schema so the handler sees a fully-populated
 * body with no manual fallback needed.
 *
 * `parameters` accepts both JSON primitives (string, number, boolean,
 * null) AND `SQLTypeMarker` objects produced by `sql.string()`,
 * `sql.number()`, `sql.date()`, `sql.timestamp()`, `sql.boolean()`. The
 * marker shape is `{ __sql_type, value }` and its `value` field is capped
 * at 4096 characters. `.strict()` on the marker schema rejects unknown
 * fields so callers can't smuggle additional keys past validation.
 *
 * Per-query parameter shape validation remains the application's concern;
 * this schema is the minimum safety net the plugin enforces for every
 * route — it caps total key count, value sizes, and rejects malformed
 * markers up front so megabyte-scale payloads never reach the query
 * processor.
 */
const sqlTypeMarkerSchema = z
  .object({
    __sql_type: z.enum(["STRING", "NUMERIC", "BOOLEAN", "DATE", "TIMESTAMP"]),
    value: z.string().max(4096),
  })
  .strict();

const queryBodySchema = z.object({
  parameters: z
    .record(
      z.string().max(255),
      z.union([
        z.string().max(4096),
        z.number(),
        z.boolean(),
        z.null(),
        sqlTypeMarkerSchema,
      ]),
    )
    .refine((obj) => Object.keys(obj).length <= 100, {
      message: "parameters may not contain more than 100 keys",
    })
    .optional(),
  format: z.enum(["JSON", "ARROW"]).default("JSON"),
});

type QueryBody = z.infer<typeof queryBodySchema>;

const logger = createLogger("analytics");

export class AnalyticsPlugin extends Plugin {
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
    // Service principal endpoints
    this.route(router, {
      name: "arrow",
      method: "get",
      path: "/arrow-result/:jobId",
      handler: async (req: express.Request, res: express.Response) => {
        await this._handleArrowRoute(req, res);
      },
    });

    this.route(router, {
      name: "query",
      method: "post",
      path: "/query/:query_key",
      body: queryBodySchema,
      handler: async (req, res) => {
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
    req: IAppRequestWithBody<QueryBody>,
    res: express.Response,
  ): Promise<void> {
    const { query_key } = req.params;
    // Body is validated+narrowed by the framework before this runs;
    // `format` defaults to "JSON" via the schema.
    const { parameters, format } = req.body;

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
        // Body schema accepts string | number | boolean | null |
        // SQLTypeMarker. `QueryProcessor.processQueryParams` is typed
        // narrower — `Record<string, SQLTypeMarker | null | undefined>`
        // — so we cast the validated input down to that shape. The
        // processor's `isSQLTypeMarker` guard re-validates each value
        // before trusting it: primitives reaching the processor today
        // surface as a runtime ValidationError there. Bridging primitives
        // to markers (or rejecting them at the handler) is a separate
        // concern; see the corresponding test.
        const processedParams = await this.queryProcessor.processQueryParams(
          query,
          parameters as Record<string, SQLTypeMarker | null | undefined>,
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
