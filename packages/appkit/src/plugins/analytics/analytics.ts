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
import { ExecutionError } from "../../errors";
import { createLogger } from "../../logging/logger";
import { Plugin, toPlugin } from "../../plugin";
import type { PluginManifest } from "../../registry";
import { queryDefaults } from "./defaults";
import manifest from "./manifest.json";
import { QueryProcessor } from "./query";
import type {
  AnalyticsFormat,
  AnalyticsQueryResponse,
  IAnalyticsConfig,
  IAnalyticsQueryRequest,
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
    const { parameters, format = "JSON_ARRAY" } =
      req.body as IAnalyticsQueryRequest;

    if (format !== "JSON_ARRAY" && format !== "ARROW_STREAM") {
      res.status(400).json({
        error: `Invalid format: ${String(format)}. Expected "JSON_ARRAY" or "ARROW_STREAM".`,
      });
      return;
    }

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

    const hashedQuery = this.queryProcessor.hashQuery(query);

    // ARROW_STREAM may resolve to EXTERNAL_LINKS, which returns pre-signed URLs
    // that typically expire ~15 minutes after issue. Cap the cache TTL well
    // under that for ARROW_STREAM so we never hand out dead URLs from cache,
    // while still benefiting from caching INLINE attachment responses (and
    // EXTERNAL_LINKS responses inside their valid window).
    const cacheTtl =
      format === "ARROW_STREAM"
        ? Math.min(queryDefaults.cache?.ttl ?? 600, 600)
        : queryDefaults.cache?.ttl;
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

    const defaultConfig: PluginExecuteConfig = {
      ...queryDefaults,
      cache: cacheConfig,
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

        return this._executeWithFormatFallback(
          executor,
          query,
          processedParams,
          format,
          signal,
        );
      },
      streamExecutionSettings,
      executorKey,
    );
  }

  /**
   * Execute a query with automatic disposition fallback for ARROW_STREAM.
   *
   * - JSON_ARRAY: always uses INLINE disposition, no fallback.
   * - ARROW_STREAM: tries INLINE first, falls back to EXTERNAL_LINKS.
   *   This handles warehouses that only support one disposition.
   */
  private async _executeWithFormatFallback(
    executor: AnalyticsPlugin,
    query: string,
    processedParams:
      | Record<string, SQLTypeMarker | null | undefined>
      | undefined,
    requestedFormat: AnalyticsFormat,
    signal?: AbortSignal,
  ): Promise<{ type: string; [key: string]: any }> {
    if (requestedFormat === "JSON_ARRAY") {
      const result = await executor.query(
        query,
        processedParams,
        { disposition: "INLINE", format: "JSON_ARRAY" },
        signal,
      );
      return { type: "result", ...result };
    }

    // ARROW_STREAM: try INLINE first, fall back to EXTERNAL_LINKS.
    try {
      const result = await executor.query(
        query,
        processedParams,
        { disposition: "INLINE", format: "ARROW_STREAM" },
        signal,
      );
      // INLINE responses with an Arrow IPC attachment are forwarded as base64
      // for the client to decode into an Arrow Table. Anything else (rare:
      // data_array under ARROW_STREAM, or an empty result) falls back to the
      // generic "result" payload.
      if (result?.attachment) {
        return { type: "arrow_inline", attachment: result.attachment };
      }
      return { type: "result", ...result };
    } catch (err: unknown) {
      // If the request was aborted, do not retry — the signal is dead and
      // a second statement would be billed but never read.
      if (signal?.aborted) {
        throw err;
      }

      if (!_isInlineArrowUnsupported(err)) {
        throw err;
      }

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
    return { type: "arrow", ...result };
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
 * Determine whether a warehouse error indicates that ARROW_STREAM + INLINE
 * is unsupported, vs an unrelated SQL/permission error.
 *
 * Preferred path: read the structured `errorCode` we now propagate from the
 * SDK's `ApiError.errorCode` and the warehouse's `status.error.error_code`
 * through `ExecutionError`. This is stable across error-message wording
 * changes.
 *
 * Substring backstop: if the upstream error didn't surface a code (legacy
 * SDK builds, or errors thrown outside the connector's wrap path), fall
 * back to requiring both INLINE and ARROW_STREAM keywords in the message
 * plus a marker phrase. The pair-requirement avoids matching unrelated SQL
 * errors that happen to mention one of the words (e.g. a column named
 * `INLINE_USERS`).
 */
function _isInlineArrowUnsupported(err: unknown): boolean {
  const structuredCode =
    err instanceof ExecutionError ? err.errorCode : undefined;
  if (
    structuredCode === "INVALID_PARAMETER_VALUE" ||
    structuredCode === "NOT_IMPLEMENTED"
  ) {
    // Structured code already tells us the warehouse rejected the request.
    // Require keyword pairing to confirm it's the disposition/format combo
    // (vs an INVALID_PARAMETER_VALUE for something else entirely).
    const msg = err instanceof Error ? err.message : String(err);
    return msg.includes("INLINE") && msg.includes("ARROW_STREAM");
  }

  // Backstop for errors without a structured code.
  const msg = err instanceof Error ? err.message : String(err);
  if (!msg.includes("INLINE") || !msg.includes("ARROW_STREAM")) {
    return false;
  }
  return (
    msg.includes("not supported") ||
    msg.includes("INVALID_PARAMETER_VALUE") ||
    msg.includes("NOT_IMPLEMENTED")
  );
}

/**
 * @internal
 */
export const analytics = toPlugin(AnalyticsPlugin);
