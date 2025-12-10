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
    // Inject core Arrow routes first (provides /arrow-result/:jobId endpoint)
    this.injectCoreArrowRoutes(router);

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
    const { parameters, format = "JSON" } = req.body as IAnalyticsQueryRequest;
    const formatParameters =
      format === "ARROW"
        ? { disposition: "EXTERNAL_LINKS", format: "ARROW_STREAM" }
        : {};

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
          JSON.stringify(format),
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

        const result = await this.query(
          query,
          processedParams,
          formatParameters,
          signal,
          {
            asUser,
          },
        );

        const type =
          formatParameters.format === "ARROW_STREAM" ? "arrow" : "result";

        return { type, ...result };
      },
      streamExecutionSettings,
      userKey,
    );
  }

  async query(
    query: string,
    parameters?: Record<string, SQLTypeMarker | null | undefined>,
    formatParameters?: Record<string, any>,
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
        ...formatParameters,
      },
      signal,
    );

    return response.result;
  }

  protected async getArrowData(
    workspaceClient: WorkspaceClient,
    jobId: string,
  ): Promise<any> {
    return await this.SQLClient.getArrowData(workspaceClient, jobId);
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
