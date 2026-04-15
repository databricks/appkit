import type express from "express";
import type { IAppRouter, PluginExecutionSettings } from "shared";
import { VectorSearchConnector } from "../../connectors/vector-search/client";
import type { VsRawResponse } from "../../connectors/vector-search/types";
import { getWorkspaceClient } from "../../context";
import { createLogger } from "../../logging/logger";
import { Plugin, toPlugin } from "../../plugin";
import type { PluginManifest } from "../../registry";
import { vectorSearchDefaults } from "./defaults";
import manifest from "./manifest.json";
import type {
  IndexConfig,
  IVectorSearchConfig,
  SearchRequest,
  SearchResponse,
} from "./types";

const logger = createLogger("vector-search");

const querySettings: PluginExecutionSettings = {
  default: vectorSearchDefaults,
};

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
    if (!this.config.indexes || Object.keys(this.config.indexes).length === 0) {
      throw new Error(
        'VectorSearchPlugin requires at least one index in "indexes" config',
      );
    }
    for (const [alias, idx] of Object.entries(this.config.indexes)) {
      if (!idx.indexName) {
        throw new Error(
          `Index "${alias}" is missing required field "indexName"`,
        );
      }
      if (!idx.columns || idx.columns.length === 0) {
        throw new Error(`Index "${alias}" is missing required field "columns"`);
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
            error: `No index configured with alias "${req.params.alias}"`,
            plugin: this.name,
          });
          return;
        }

        const body: SearchRequest = req.body;
        if (!body.queryText && !body.queryVector) {
          res.status(400).json({
            error: "queryText or queryVector is required",
            plugin: this.name,
          });
          return;
        }

        try {
          const prepared = await this._prepareQuery(body, indexConfig);
          const plugin =
            indexConfig.auth === "on-behalf-of-user" ? this.asUser(req) : this;

          const result = await plugin.execute(
            async (signal) =>
              this.connector.query(
                getWorkspaceClient(),
                {
                  indexName: indexConfig.indexName,
                  queryText: prepared.queryText,
                  queryVector: prepared.queryVector,
                  columns: prepared.columns,
                  numResults: prepared.numResults,
                  queryType: prepared.queryType,
                  filters: body.filters,
                  reranker: prepared.rerankerConfig,
                },
                signal,
              ),
            querySettings,
          );

          if (!result.ok) {
            res
              .status(result.status)
              .json({ error: result.message, plugin: this.name });
            return;
          }
          res.json(this._parseResponse(result.data, prepared.queryType));
        } catch (error) {
          this._handleError(res, error, "Query failed");
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
            error: `No index configured with alias "${req.params.alias}"`,
            plugin: this.name,
          });
          return;
        }

        if (!indexConfig.pagination) {
          res.status(400).json({
            error: `Pagination is not enabled for index "${req.params.alias}"`,
            plugin: this.name,
          });
          return;
        }

        if (!indexConfig.endpointName) {
          res.status(400).json({
            error: `Index "${req.params.alias}" is missing endpointName required for pagination`,
            plugin: this.name,
          });
          return;
        }

        const { pageToken } = req.body;
        if (!pageToken) {
          res.status(400).json({
            error: "pageToken is required",
            plugin: this.name,
          });
          return;
        }

        try {
          const plugin =
            indexConfig.auth === "on-behalf-of-user" ? this.asUser(req) : this;

          const result = await plugin.execute(
            async (signal) =>
              this.connector.queryNextPage(
                getWorkspaceClient(),
                {
                  indexName: indexConfig.indexName,
                  endpointName: indexConfig.endpointName as string,
                  pageToken,
                },
                signal,
              ),
            querySettings,
          );

          if (!result.ok) {
            res
              .status(result.status)
              .json({ error: result.message, plugin: this.name });
            return;
          }
          res.json(
            this._parseResponse(result.data, indexConfig.queryType ?? "hybrid"),
          );
        } catch (error) {
          this._handleError(res, error, "Next-page query failed");
        }
      },
    });

    this.route(router, {
      name: "getConfig",
      method: "get",
      path: "/:alias/config",
      handler: async (req: express.Request, res: express.Response) => {
        const { alias } = req.params;
        const indexConfig = this._resolveIndex(alias);
        if (!indexConfig) {
          res.status(404).json({
            error: `No index configured with alias "${alias}"`,
            plugin: this.name,
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

  /**
   * Programmatic query API — available as `appkit.vectorSearch.query()`.
   * When called through `asUser(req)`, executes with the user's credentials.
   */
  async query(alias: string, request: SearchRequest): Promise<SearchResponse> {
    const indexConfig = this._resolveIndex(alias);
    if (!indexConfig) {
      throw new Error(`No index configured with alias "${alias}"`);
    }

    const prepared = await this._prepareQuery(request, indexConfig);

    const result = await this.execute(
      async (signal) =>
        this.connector.query(
          getWorkspaceClient(),
          {
            indexName: indexConfig.indexName,
            queryText: prepared.queryText,
            queryVector: prepared.queryVector,
            columns: prepared.columns,
            numResults: prepared.numResults,
            queryType: prepared.queryType,
            filters: request.filters,
            reranker: prepared.rerankerConfig,
          },
          signal,
        ),
      querySettings,
    );

    if (!result.ok) {
      throw new Error(
        `Vector search query failed for index "${alias}": ${result.message}`,
      );
    }

    return this._parseResponse(result.data, prepared.queryType);
  }

  async shutdown(): Promise<void> {
    // No streams or persistent connections to clean up
  }

  exports() {
    return {
      query: this.query.bind(this),
    };
  }

  private _resolveIndex(alias: string): IndexConfig | undefined {
    return this.config.indexes?.[alias];
  }

  private async _prepareQuery(
    request: SearchRequest,
    indexConfig: IndexConfig,
  ): Promise<{
    queryText: string | undefined;
    queryVector: number[] | undefined;
    queryType: "ann" | "hybrid" | "full_text";
    columns: string[];
    numResults: number;
    rerankerConfig: { columnsToRerank: string[] } | undefined;
  }> {
    const queryType = request.queryType ?? indexConfig.queryType ?? "hybrid";
    let queryText = request.queryText;
    let queryVector = request.queryVector;

    if (indexConfig.embeddingFn && queryText && !queryVector) {
      try {
        queryVector = await indexConfig.embeddingFn(queryText);
        queryText = undefined;
      } catch (error) {
        throw new Error(
          `Embedding generation failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const columns = request.columns ?? indexConfig.columns;
    return {
      queryText,
      queryVector,
      queryType,
      columns,
      numResults: request.numResults ?? indexConfig.numResults ?? 20,
      rerankerConfig: this._resolveReranker(
        request.reranker,
        indexConfig,
        columns,
      ),
    };
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
      nextPageToken: raw.next_page_token ?? null,
    };
  }

  private _handleError(
    res: express.Response,
    error: unknown,
    fallbackMessage: string,
  ): void {
    logger.error("%s: %O", fallbackMessage, error);
    const message = error instanceof Error ? error.message : fallbackMessage;
    res.status(500).json({ error: message, plugin: this.name });
  }
}

export const vectorSearch = toPlugin(VectorSearchPlugin);
