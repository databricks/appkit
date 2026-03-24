import type express from "express";
import type { IAppRouter } from "shared";
import { VectorSearchConnector } from "../../connectors";
import { getWorkspaceClient } from "../../context";
import { createLogger } from "../../logging/logger";
import { Plugin, toPlugin } from "../../plugin";
import type { PluginManifest } from "../../registry";
import type { VsRawResponse } from "../../connectors/vector-search/types";
import manifest from "./manifest.json";
import type {
  IVectorSearchConfig,
  IndexConfig,
  SearchRequest,
  SearchResponse,
} from "./types";

const logger = createLogger("vector-search");

export class VectorSearchPlugin extends Plugin<IVectorSearchConfig> {
  static manifest = manifest as PluginManifest<"vector-search">;

  protected static description =
    "Query Databricks Vector Search indexes with hybrid search, reranking, and pagination";
  protected declare config: IVectorSearchConfig;

  private connector: VectorSearchConnector;

  constructor(config: IVectorSearchConfig) {
    super(config);
    this.config = config;
    this.connector = new VectorSearchConnector({
      timeout: config.timeout,
      telemetry: config.telemetry,
    });
  }

  async setup(): Promise<void> {
    for (const [alias, idx] of Object.entries(this.config.indexes)) {
      if (!idx.indexName) {
        throw new Error(
          `Index "${alias}" is missing required field "indexName"`,
        );
      }
      if (!idx.columns || idx.columns.length === 0) {
        throw new Error(
          `Index "${alias}" is missing required field "columns"`,
        );
      }
      if (idx.pagination && !idx.endpointName) {
        throw new Error(
          `Index "${alias}" has pagination enabled but is missing "endpointName"`,
        );
      }
    }
    logger.debug(
      "Vector Search plugin configured with %d index(es)",
      Object.keys(this.config.indexes).length,
    );
  }

  injectRoutes(router: IAppRouter) {
    this.route(router, {
      name: "query",
      method: "post",
      path: "/:alias/query",
      handler: async (req: express.Request, res: express.Response) => {
        const indexConfig = this._resolveIndex(req.params.alias);
        if (!indexConfig) {
          res.status(404).json({
            code: "INDEX_NOT_FOUND",
            message: `No index configured with alias "${req.params.alias}"`,
            statusCode: 404,
          });
          return;
        }

        if (indexConfig.auth === "on-behalf-of-user") {
          await this.asUser(req)._handleQuery(req, res, indexConfig);
        } else {
          await this._handleQuery(req, res, indexConfig);
        }
      },
    });

    this.route(router, {
      name: "queryNextPage",
      method: "post",
      path: "/:alias/next-page",
      handler: async (req: express.Request, res: express.Response) => {
        const indexConfig = this._resolveIndex(req.params.alias);
        if (!indexConfig) {
          res.status(404).json({
            code: "INDEX_NOT_FOUND",
            message: `No index configured with alias "${req.params.alias}"`,
            statusCode: 404,
          });
          return;
        }

        if (indexConfig.auth === "on-behalf-of-user") {
          await this.asUser(req)._handleNextPage(req, res, indexConfig);
        } else {
          await this._handleNextPage(req, res, indexConfig);
        }
      },
    });

    this.route(router, {
      name: "getConfig",
      method: "get",
      path: "/:alias/config",
      handler: (req: express.Request, res: express.Response) => {
        const { alias } = req.params;
        const indexConfig = this._resolveIndex(alias);
        if (!indexConfig) {
          res.status(404).json({
            code: "INDEX_NOT_FOUND",
            message: `No index configured with alias "${alias}"`,
            statusCode: 404,
          });
          return;
        }
        res.json({
          alias,
          columns: indexConfig.columns,
          queryType: indexConfig.queryType ?? "hybrid",
          numResults: indexConfig.numResults ?? 20,
          reranker: !!indexConfig.reranker,
          pagination: !!indexConfig.pagination,
        });
      },
    });
  }

  async _handleQuery(
    req: express.Request,
    res: express.Response,
    indexConfig: IndexConfig,
  ): Promise<void> {
    const body: SearchRequest = req.body;

    if (!body.queryText && !body.queryVector) {
      res.status(400).json({
        code: "INVALID_QUERY",
        message: "queryText or queryVector is required",
        statusCode: 400,
      });
      return;
    }

    const event = logger.event(req);
    event
      ?.setComponent("vector-search", "query")
      .setContext("vector-search", {
        index: indexConfig.indexName,
        query_type: body.queryType ?? indexConfig.queryType ?? "hybrid",
        plugin: this.name,
      });

    const queryType = body.queryType ?? indexConfig.queryType ?? "hybrid";
    let queryText = body.queryText;
    let queryVector = body.queryVector;

    if (indexConfig.embeddingFn && queryText && !queryVector) {
      queryVector = await indexConfig.embeddingFn(queryText);
      queryText = undefined;
    }

    const rerankerConfig = this._resolveReranker(
      body.reranker,
      indexConfig,
      body.columns ?? indexConfig.columns,
    );

    try {
      const workspaceClient = getWorkspaceClient();
      const raw = await this.connector.query(
        workspaceClient,
        {
          indexName: indexConfig.indexName,
          queryText,
          queryVector,
          columns: body.columns ?? indexConfig.columns,
          numResults: body.numResults ?? indexConfig.numResults ?? 20,
          queryType,
          filters: body.filters,
          reranker: rerankerConfig,
        },
      );
      res.json(this._parseResponse(raw, queryType));
    } catch (error) {
      logger.error("Vector search query failed: %O", error);
      const statusCode =
        (error as { statusCode?: number }).statusCode ?? 500;
      res.status(statusCode).json({
        code: (error as { code?: string }).code ?? "INTERNAL",
        message:
          error instanceof Error ? error.message : "Query execution failed",
        statusCode,
      });
    }
  }

  async _handleNextPage(
    req: express.Request,
    res: express.Response,
    indexConfig: IndexConfig,
  ): Promise<void> {
    if (!indexConfig.pagination) {
      res.status(400).json({
        code: "INVALID_QUERY",
        message: `Pagination is not enabled for index "${req.params.alias}"`,
        statusCode: 400,
      });
      return;
    }

    const { pageToken } = req.body;
    if (!pageToken) {
      res.status(400).json({
        code: "INVALID_QUERY",
        message: "pageToken is required",
        statusCode: 400,
      });
      return;
    }

    try {
      const workspaceClient = getWorkspaceClient();
      const raw = await this.connector.queryNextPage(
        workspaceClient,
        {
          indexName: indexConfig.indexName,
          endpointName: indexConfig.endpointName!,
          pageToken,
        },
      );
      res.json(this._parseResponse(raw, "hybrid"));
    } catch (error) {
      logger.error("Vector search next-page query failed: %O", error);
      const statusCode =
        (error as { statusCode?: number }).statusCode ?? 500;
      res.status(statusCode).json({
        code: (error as { code?: string }).code ?? "INTERNAL",
        message:
          error instanceof Error ? error.message : "Next-page query failed",
        statusCode,
      });
    }
  }

  /**
   * Programmatic query API — available as `appkit.vectorSearch.query()`.
   * When called through `asUser(req)`, executes with the user's credentials.
   */
  async query(alias: string, request: SearchRequest): Promise<SearchResponse> {
    const indexConfig = this._resolveIndex(alias);
    if (!indexConfig) {
      throw {
        code: "INDEX_NOT_FOUND" as const,
        message: `No index configured with alias "${alias}"`,
        statusCode: 404,
      };
    }

    const queryType = request.queryType ?? indexConfig.queryType ?? "hybrid";
    let queryText = request.queryText;
    let queryVector = request.queryVector;

    if (indexConfig.embeddingFn && queryText && !queryVector) {
      queryVector = await indexConfig.embeddingFn(queryText);
      queryText = undefined;
    }

    const rerankerConfig = this._resolveReranker(
      request.reranker,
      indexConfig,
      request.columns ?? indexConfig.columns,
    );

    const workspaceClient = getWorkspaceClient();
    const raw = await this.connector.query(workspaceClient, {
      indexName: indexConfig.indexName,
      queryText,
      queryVector,
      columns: request.columns ?? indexConfig.columns,
      numResults: request.numResults ?? indexConfig.numResults ?? 20,
      queryType,
      filters: request.filters,
      reranker: rerankerConfig,
    });

    return this._parseResponse(raw, queryType);
  }

  async shutdown(): Promise<void> {
    this.streamManager.abortAll();
  }

  exports() {
    return {
      query: this.query.bind(this),
    };
  }

  private _resolveIndex(alias: string): IndexConfig | undefined {
    return this.config.indexes[alias];
  }

  private _resolveReranker(
    requestReranker: boolean | undefined,
    indexConfig: IndexConfig,
    columns: string[],
  ): { columnsToRerank: string[] } | undefined {
    const shouldRerank = requestReranker ?? indexConfig.reranker;
    if (!shouldRerank) return undefined;

    if (typeof indexConfig.reranker === "object") {
      return indexConfig.reranker;
    }
    return { columnsToRerank: columns.filter((c) => c !== "id") };
  }

  private _parseResponse(
    raw: VsRawResponse,
    queryType: "ann" | "hybrid" | "full_text",
  ): SearchResponse {
    const columnNames = raw.manifest.columns.map((c) => c.name);
    const scoreIndex = columnNames.indexOf("score");

    const results = raw.result.data_array.map((row) => {
      const data: Record<string, unknown> = {};
      for (let i = 0; i < columnNames.length; i++) {
        if (columnNames[i] !== "score") data[columnNames[i]] = row[i];
      }
      return {
        score: scoreIndex >= 0 ? (row[scoreIndex] as number) : 0,
        data,
      };
    });

    return {
      results,
      totalCount: raw.result.row_count,
      queryTimeMs:
        raw.debug_info?.response_time ?? raw.debug_info?.latency_ms ?? 0,
      queryType,
      fromCache: false,
      nextPageToken: raw.next_page_token ?? null,
    };
  }
}

export const vectorSearch = toPlugin(VectorSearchPlugin);
