import type { WorkspaceClient } from "@databricks/sdk-experimental";
import {
  analyticsRoutes,
  type IAppRouter,
  type PluginExecuteConfig,
  type SQLTypeMarker,
  type StreamExecutionSettings,
} from "shared";
import { SQLWarehouseConnector } from "../connectors";
import { Plugin, toPlugin } from "../plugin";
import type { Request, Response } from "../utils";
import { getRequestContext, getWorkspaceClient } from "../utils";
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
    this.route(router, {
      name: "arrow",
      method: "get",
      path: "/arrow-result/:jobId",
      handler: async (req: Request, res: Response) => {
        await this._handleArrowRoute(req, res);
      },
    });

    this.route(router, {
      name: "arrowAsUser",
      method: "get",
      path: "/users/me/arrow-result/:jobId",
      handler: async (req: Request, res: Response) => {
        await this._handleArrowRoute(req, res, { asUser: true });
      },
    });

    this.route<AnalyticsQueryResponse>(router, {
      name: "queryAsUser",
      method: "post",
      path: analyticsRoutes.queryAsUser,
      handler: async (req: Request, res: Response) => {
        await this._handleQueryRoute(req, res, { asUser: true });
      },
    });

    this.route<AnalyticsQueryResponse>(router, {
      name: "query",
      method: "post",
      path: analyticsRoutes.query,
      handler: async (req: Request, res: Response) => {
        await this._handleQueryRoute(req, res, { asUser: false });
      },
    });
  }

  private async _handleArrowRoute(
    req: Request,
    res: Response,
    { asUser = false }: { asUser?: boolean } = {},
  ): Promise<void> {
    try {
      const { jobId } = req.params;

      const workspaceClient = getWorkspaceClient(asUser);

      console.log(
        `Processing Arrow job request: ${jobId} for plugin: ${this.name}`,
      );

      const result = await this.getArrowData(workspaceClient, jobId);

      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Length", result.data.length.toString());
      res.setHeader("Cache-Control", "public, max-age=3600");

      console.log(
        `Sending Arrow buffer: ${result.data.length} bytes for job ${jobId}`,
      );
      res.send(Buffer.from(result.data));
    } catch (error) {
      console.error(`Arrow job error for ${this.name}:`, error);
      res.status(404).json({
        error: error instanceof Error ? error.message : "Arrow job not found",
        plugin: this.name,
      });
    }
  }

  private async _handleQueryRoute(
    req: Request,
    res: Response,
    { asUser = false }: { asUser?: boolean } = {},
  ): Promise<void> {
    const { query_key } = req.params;
    const { parameters, format = "JSON" } = req.body as IAnalyticsQueryRequest;
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
          queryParameters.formatParameters,
          signal,
          {
            asUser,
          },
        );

        return { type: queryParameters.type, ...result };
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
    const workspaceClient = getWorkspaceClient(asUser);

    const { statement, parameters: sqlParameters } =
      this.queryProcessor.convertToSQLParameters(query, parameters);

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

  // If we need arrow stream in more plugins we can define this as a base method in the core plugin class
  // and have a generic endpoint for each plugin that consumes this arrow data.
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
}

export const analytics = toPlugin<
  typeof AnalyticsPlugin,
  IAnalyticsConfig,
  "analytics"
>(AnalyticsPlugin, "analytics");
