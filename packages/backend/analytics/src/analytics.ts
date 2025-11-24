import { SQLWarehouseConnector } from "@databricks-apps/connectors";
import { Plugin, toPlugin } from "@databricks-apps/plugin";
import type {
  IAppRouter,
  PluginExecuteConfig,
  StreamExecutionSettings,
} from "@databricks-apps/types";
import { queryDefaults } from "./defaults";
import { QueryProcessor } from "./query";
import type { IAnalyticsConfig, IAnalyticsQueryRequest } from "./types";
import type { Request, Response } from "@databricks-apps/utils";
import { getRequestContext } from "@databricks-apps/utils";

export class AnalyticsPlugin extends Plugin {
  name = "analytics";
  envVars = [];

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
    });
  }

  injectRoutes(router: IAppRouter) {
    // query router: user-level
    router.post("/users/me/query/:query_key", async (req, res) => {
      await this._handleQueryRoute(req, res, { asUser: true });
    });

    // query-router: app-service level
    router.post("/query/:query_key", async (req, res) => {
      await this._handleQueryRoute(req, res, { asUser: false });
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
    parameters?: Record<string, any>,
    signal?: AbortSignal,
    { asUser = false }: { asUser?: boolean } = {},
  ): Promise<any> {
    const requestContext = getRequestContext();
    const { statement, parameters: sqlParameters } =
      this.queryProcessor.convertToSQLParameters(query, parameters);

    const workspaceClient = asUser
      ? requestContext.userDatabricksClient
      : requestContext.serviceDatabricksClient;

    try {
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
    } catch (error) {
      console.error(error);
      throw new Error("Query execution failed");
    }
  }

  async shutdown(): Promise<void> {
    this.streamManager.abortAll();
  }
}

export const analytics = toPlugin<
  typeof AnalyticsPlugin,
  IAnalyticsConfig,
  "analytics"
>(AnalyticsPlugin, "analytics");
