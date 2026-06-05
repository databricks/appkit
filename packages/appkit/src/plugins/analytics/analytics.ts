import type { WorkspaceClient } from "@databricks/sdk-experimental";
import type express from "express";
import type {
  AgentToolDefinition,
  IAppRouter,
  PluginExecuteConfig,
  SQLTypeMarker,
  StreamExecutionSettings,
  ToolProvider,
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
import { ExecutionError } from "../../errors";
import { createLogger } from "../../logging/logger";
import { Plugin, toPlugin } from "../../plugin";
import type { PluginManifest } from "../../registry";
import { queryDefaults } from "./defaults";
import manifest from "./manifest.json";
import { QueryProcessor } from "./query";
import type {
  AnalyticsQueryResponse,
  AnalyticsStreamMessage,
  IAnalyticsConfig,
  IAnalyticsQueryRequest,
  WarehouseStatus,
} from "./types";
import { normalizeAnalyticsFormat } from "./types";

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
    const { parameters, format: rawFormat = "JSON_ARRAY" } =
      req.body as IAnalyticsQueryRequest;
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

    const queryParameters =
      format === "ARROW_STREAM"
        ? {
            formatParameters: {
              disposition: "EXTERNAL_LINKS",
              format: "ARROW_STREAM",
            },
            type: "arrow" as const,
          }
        : {
            type: "result" as const,
          };

    const hashedQuery = this.queryProcessor.hashQuery(query);

    // Cache/retry/timeout are scoped to the SQL execution itself (inner
    // `execute`) so the warehouse-readiness phase isn't subject to retries
    // and the generator value never leaks into the cache.
    const sqlConfig: PluginExecuteConfig = {
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

        const sqlResult = await executor.execute(
          async (sig) => {
            const processedParams =
              await self.queryProcessor.processQueryParams(query, parameters);
            const result = await executor.query(
              query,
              processedParams,
              queryParameters.formatParameters,
              sig,
            );
            return { type: queryParameters.type, ...result };
          },
          { default: sqlConfig },
          executorKey,
        );

        if (!sqlResult.ok) {
          // Surface a typed AppKitError so StreamManager can categorize via
          // the structured `code`. The HTTP status code from `execute()`
          // doesn't apply to SSE error frames.
          throw ExecutionError.statementFailed(sqlResult.message);
        }

        yield sqlResult.data as AnalyticsStreamMessage;
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
 * @internal
 */
export const analytics = toPlugin(AnalyticsPlugin);
