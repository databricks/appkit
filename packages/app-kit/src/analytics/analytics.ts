import { existsSync, type FSWatcher, watch } from "node:fs";
import path from "node:path";
import type { WorkspaceClient } from "@databricks/sdk-experimental";
import type {
  IAppRouter,
  PluginExecuteConfig,
  QuerySchemas,
  StreamExecutionSettings,
} from "shared";
import { SQLWarehouseConnector } from "../connectors";
import { Plugin, toPlugin } from "../plugin";
import type { SQLTypeMarker } from "../sql/helpers";
import type { Request, Response } from "../utils";
import { getRequestContext } from "../utils";
import { generateQueryRegistryTypes } from "../utils/type-generator";
import { queryDefaults } from "./defaults";
import { QueryProcessor } from "./query";
import {
  analyticsQueryResponseSchema,
  type IAnalyticsConfig,
  type IAnalyticsQueryRequest,
} from "./types";

export class AnalyticsPlugin extends Plugin {
  name = "analytics";
  envVars = [];

  protected static description = "Analytics plugin for data analysis";
  protected declare config: IAnalyticsConfig;

  // analytics services
  private SQLClient: SQLWarehouseConnector;
  private queryProcessor: QueryProcessor;

  private schemaWatcher: FSWatcher | null = null;

  constructor(config: IAnalyticsConfig) {
    super(config);
    this.config = config;
    this.queryProcessor = new QueryProcessor();

    this.SQLClient = new SQLWarehouseConnector({
      timeout: config.timeout,
      telemetry: this.telemetry,
    });

    if (process.env.NODE_ENV === "development") {
      this._generateQueryTypes();
    }
  }

  injectRoutes(router: IAppRouter) {
    this.route(router, {
      method: "post",
      path: "/users/me/query/:query_key",
      schema: analyticsQueryResponseSchema,
      handler: async (req, res) => {
        await this._handleQueryRoute(req, res, { asUser: true });
      },
    });

    this.route(router, {
      method: "post",
      path: "/query/:query_key",
      schema: analyticsQueryResponseSchema,
      handler: async (req, res) => {
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

    if (this.schemaWatcher) {
      this.schemaWatcher.close();
      this.schemaWatcher = null;
    }
  }

  // generate query types for development
  private _generateQueryTypes() {
    const schemaDir = path.join(process.cwd(), "config/queries");
    const schemaPath = path.join(schemaDir, "schema.ts");

    const typePath =
      this.config.typePath || path.join(process.cwd(), "client", "src");

    const generate = () => {
      let querySchemas: QuerySchemas = {};
      try {
        delete require.cache[require.resolve(schemaPath)];
        querySchemas = require(schemaPath).querySchemas;
      } catch (error) {
        if (existsSync(schemaPath)) {
          console.warn(
            `[AppKit] Failed to load query schemas from ${schemaPath}:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
      generateQueryRegistryTypes(querySchemas, typePath);
    };

    generate();

    if (existsSync(schemaPath)) {
      this.schemaWatcher = watch(
        schemaDir,
        { recursive: true },
        (_event, filename) => {
          if (filename === "schema.ts") {
            console.log(`[AppKit] Query schema changed, regenerating types...`);
            generate();
          }
        },
      );
    }
  }
}

export const analytics = toPlugin<
  typeof AnalyticsPlugin,
  IAnalyticsConfig,
  "analytics"
>(AnalyticsPlugin, "analytics");
