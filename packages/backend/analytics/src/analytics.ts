import { SQLWarehouseConnector } from "@databricks-apps/connectors";
import { Plugin, toPlugin } from "@databricks-apps/plugin";
import type {
  IAppRouter,
  IAuthManager,
  PluginExecuteConfig,
  StreamExecutionSettings,
} from "@databricks-apps/types";
import { queryDefaults } from "./defaults";
import { QueryProcessor } from "./query";
import type { IAnalyticsConfig, IAnalyticsQueryRequest } from "./types";

export class AnalyticsPlugin extends Plugin {
  name = "analytics";
  envVars = ["DATABRICKS_HOST", "DATABRICKS_WAREHOUSE_ID"];

  protected static description = "Analytics plugin for data analysis";
  protected declare config: IAnalyticsConfig;

  // analytics services
  private SQLClient: SQLWarehouseConnector;
  private queryProcessor: QueryProcessor;

  constructor(config: IAnalyticsConfig, auth: IAuthManager) {
    super(config, auth);
    this.config = config;
    this.queryProcessor = new QueryProcessor();

    this.SQLClient = new SQLWarehouseConnector({
      host: process.env.DATABRICKS_HOST || "",
      timeout: config.timeout,
      auth: this.auth,
    });
  }

  injectRoutes(router: IAppRouter) {
    // query router: user-level
    router.post("/users/me/query/:query_key", async (req, res) => {
      const userToken = req.header("x-forwarded-access-token");
      if (!userToken) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      await this._handleQueryRoute(req, res, userToken);
    });

    // query-router: app-service level
    router.post("/query/:query_key", async (req, res) => {
      await this._handleQueryRoute(req, res);
    });
  }

  private async _handleQueryRoute(
    req: any,
    res: any,
    userToken?: string
  ): Promise<void> {
    const { query_key } = req.params;
    const { parameters } = req.body as IAnalyticsQueryRequest;

    if (!query_key) {
      return res.status(400).json({ error: "query_key is required" });
    }

    const query = await this.app.getAppQuery(
      query_key,
      req,
      this.devFileReader
    );

    if (!query) {
      return res.status(404).json({ error: "Query not found" });
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
        ], // @TODO: need to handle key ordering issues
      },
    };

    const streamExecutionSettings: StreamExecutionSettings = {
      default: defaultConfig,
    };

    await this.executeStream(
      res,
      async (signal) => {
        const processedParams = this.queryProcessor.processQueryParams(
          query,
          parameters
        );

        const result = userToken
          ? await this.asUser(userToken).query(query, processedParams, signal)
          : await this.query(query, processedParams, signal);

        return { type: "result", ...result };
      },
      streamExecutionSettings
    );
  }

  async query(
    query: string,
    parameters?: Record<string, any>,
    signal?: AbortSignal
  ): Promise<any> {
    const { statement, parameters: sqlParameters } =
      this.queryProcessor.convertToSQLParameters(query, parameters);
    const warehouseId = process.env.DATABRICKS_WAREHOUSE_ID;

    if (!warehouseId) {
      throw new Error("Analytics service is not configured");
    }

    try {
      const response = await this.SQLClient.executeStatement(
        {
          statement,
          parameters: sqlParameters,
          warehouse_id: warehouseId,
        },
        signal,
        this.userToken ? { userToken: this.userToken } : undefined
      );

      return response.result;
    } catch (_error) {
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
