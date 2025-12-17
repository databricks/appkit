import type { WorkspaceClient } from "@databricks/sdk-experimental";
import type {
  IAppRouter,
  PluginExecuteConfig,
  SQLTypeMarker,
  StreamExecutionSettings,
} from "shared";
import { SQLWarehouseConnector } from "../connectors";
import { Plugin, toPlugin } from "../plugin";
import type { Request, Response } from "../utils";
import { getRequestContext } from "../utils";
import { queryDefaults } from "./defaults";
import { QueryProcessor } from "./query";
import type {
  AnalyticsQueryResponse,
  IAnalyticsConfig,
  IAnalyticsQueryRequest,
} from "./types";

/**
 * Analytics plugin for executing SQL queries against Databricks SQL Warehouse.
 *
 * Provides HTTP endpoints for query execution:
 * - POST /query/:query_key - Execute query as service user
 * - POST /users/me/query/:query_key - Execute query as authenticated user
 *
 * Features:
 * - Automatic query caching with configurable TTL
 * - Parameter substitution in SQL queries
 * - Streaming results via Server-Sent Events
 * - Telemetry and observability
 *
 * @example
 * Query file: config/queries/user_stats.sql
 * ```sql
 * SELECT * FROM users WHERE user_id = :user_id
 * ```
 *
 * Client usage:
 * ```typescript
 * const response = await fetch('/query/user_stats', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({ parameters: { user_id: 123 } })
 * });
 * ```
 */
export class AnalyticsPlugin extends Plugin {
  name = "analytics";
  envVars = [];
  requiresDatabricksClient = true;

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
      method: "post",
      path: "/users/me/query/:query_key",
      handler: async (req: Request, res: Response) => {
        await this._handleQueryRoute(req, res, { asUser: true });
      },
    });

    this.route<AnalyticsQueryResponse>(router, {
      method: "post",
      path: "/query/:query_key",
      handler: async (req: Request, res: Response) => {
        await this._handleQueryRoute(req, res, { asUser: false });
      },
    });
  }

  private async _handleQueryRoute(
    req: Request,
    res: Response,
    { asUser = false }: { asUser?: boolean } = {},
  ): Promise<void> {
    const { query_key } = req.params;
    const { parameters } = req.body as IAnalyticsQueryRequest;
    const requestContext = getRequestContext();
    const userKey = asUser
      ? requestContext.userId
      : requestContext.serviceUserId;

    if (!query_key) {
      res.status(400).json({ error: "query_key is required" });
      return;
    }

    const query = await this.app.getAppQuery(
      query_key,
      req,
      this.devFileReader,
    );

    if (!query) {
      res.status(404).json({ error: "Query not found" });
      return;
    }

    const hashedQuery = this.queryProcessor.hashQuery(query);

    const defaultConfig: PluginExecuteConfig = {
      ...queryDefaults,
      cache: {
        ...queryDefaults.cache,
        cacheKey: [
          "analytics:query",
          query_key,
          JSON.stringify(parameters),
          hashedQuery,
          userKey,
        ],
      },
    };

    const streamExecutionSettings: StreamExecutionSettings = {
      default: defaultConfig,
    };

    await this.executeStream(
      res,
      async (signal) => {
        const processedParams = await this.queryProcessor.processQueryParams(
          query,
          parameters,
        );

        const result = await this.query(query, processedParams, signal, {
          asUser,
        });

        return { type: "result", ...result };
      },
      streamExecutionSettings,
      userKey,
    );
  }

  async query(
    query: string,
    parameters?: Record<string, SQLTypeMarker | null | undefined>,
    signal?: AbortSignal,
    { asUser = false }: { asUser?: boolean } = {},
  ): Promise<any> {
    const requestContext = getRequestContext();
    const { statement, parameters: sqlParameters } =
      this.queryProcessor.convertToSQLParameters(query, parameters);

    let workspaceClient: WorkspaceClient;
    if (asUser) {
      if (!requestContext.userDatabricksClient) {
        throw new Error(
          `User token passthrough feature is not enabled for workspace ${requestContext.workspaceId}.`,
        );
      }
      workspaceClient = requestContext.userDatabricksClient;
    } else {
      workspaceClient = requestContext.serviceDatabricksClient;
    }

    const response = await this.SQLClient.executeStatement(
      workspaceClient,
      {
        statement,
        warehouse_id: await requestContext.warehouseId,
        parameters: sqlParameters,
      },
      signal,
    );

    return response.result;
  }

  async shutdown(): Promise<void> {
    this.streamManager.abortAll();
  }
}

/**
 * Creates an analytics plugin instance for SQL query execution.
 *
 * The analytics plugin provides:
 * - SQL query execution against Databricks SQL Warehouse
 * - Automatic caching of query results
 * - Type-safe query parameters
 * - User-scoped and service-scoped query endpoints
 * - Streaming query results via Server-Sent Events
 *
 * Queries are loaded from `.sql` files in your query directory and can be
 * executed via HTTP endpoints with parameter substitution.
 *
 * @param config - Analytics configuration options
 * @param config.timeout - Query execution timeout in milliseconds
 * @param config.telemetry - Telemetry configuration for observability
 * @returns Plugin definition for use with createApp
 *
 * @example
 * Basic analytics setup
 * ```typescript
 * import { createApp, server, analytics } from '@databricks/app-kit';
 *
 * const app = await createApp({
 *   plugins: [
 *     server(),
 *     analytics({})
 *   ]
 * });
 * ```
 *
 * @example
 * Analytics with custom timeout
 * ```typescript
 * import { createApp, analytics } from '@databricks/app-kit';
 *
 * const app = await createApp({
 *   plugins: [
 *     analytics({
 *       timeout: 60000 // 60 seconds
 *     })
 *   ]
 * });
 * ```
 */
export const analytics = toPlugin<
  typeof AnalyticsPlugin,
  IAnalyticsConfig,
  "analytics"
>(AnalyticsPlugin, "analytics");
