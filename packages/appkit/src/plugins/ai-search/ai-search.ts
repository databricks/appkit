import type express from "express";
import type { IAppRouter, PluginExecutionSettings } from "shared";
import { AiSearchConnector } from "../../connectors/ai-search/client";
import type {
  VsQueryParams,
  VsRawResponse,
} from "../../connectors/ai-search/types";
import { getWorkspaceClient } from "../../context";
import { createLogger } from "../../logging/logger";
import { Plugin, toPlugin } from "../../plugin";
import type { PluginManifest } from "../../registry";
import { aiSearchDefaults } from "./defaults";
import manifest from "./manifest.json";
import type {
  IAiSearchConfig,
  IndexConfig,
  SearchRequest,
  SearchResponse,
  SearchResult,
} from "./types";

const logger = createLogger("ai-search");

const querySettings: PluginExecutionSettings = {
  default: aiSearchDefaults,
};

export class AiSearchPlugin extends Plugin<IAiSearchConfig> {
  static manifest = manifest as PluginManifest<"ai-search">;

  protected static description =
    "Query Databricks Vector Search indexes with hybrid search, reranking, and pagination";
  protected declare config: IAiSearchConfig;

  private connector: AiSearchConnector;

  constructor(config: IAiSearchConfig) {
    super(config);
    this.config = config;
    this.connector = new AiSearchConnector({
      timeout: config.timeout,
      telemetry: config.telemetry,
    });
  }

  async setup(): Promise<void> {
    if (!this.config.indexes || Object.keys(this.config.indexes).length === 0) {
      throw new Error(
        'AiSearchPlugin requires at least one index in "indexes" config',
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
                { indexName: indexConfig.indexName, ...prepared },
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
   * Programmatic query API — available as `appkit.aiSearch.query()`.
   * When called through `asUser(req)`, executes with the user's credentials.
   */
  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    alias: string,
    request: SearchRequest,
  ): Promise<SearchResponse<T>> {
    const indexConfig = this._resolveIndex(alias);
    if (!indexConfig) {
      throw new Error(`No index configured with alias "${alias}"`);
    }

    const prepared = await this._prepareQuery(request, indexConfig);

    const result = await this.execute(
      async (signal) =>
        this.connector.query(
          getWorkspaceClient(),
          { indexName: indexConfig.indexName, ...prepared },
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
  ): Promise<Omit<VsQueryParams, "indexName">> {
    const queryType = request.queryType ?? indexConfig.queryType ?? "hybrid";
    let queryText = request.queryText;
    let queryVector = request.queryVector;

    // full_text uses no vector; hybrid keeps the text for its keyword half.
    if (
      indexConfig.embeddingFn &&
      queryText &&
      !queryVector &&
      queryType !== "full_text"
    ) {
      try {
        queryVector = await indexConfig.embeddingFn(queryText);
        if (queryType === "ann") queryText = undefined;
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
      filters: request.filters,
      reranker: this._resolveReranker(request.reranker, indexConfig, columns),
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

  private _parseResponse<
    T extends Record<string, unknown> = Record<string, unknown>,
  >(
    raw: VsRawResponse,
    queryType: "ann" | "hybrid" | "full_text",
  ): SearchResponse<T> {
    const columnNames = raw.manifest.columns.map((c) => c.name);
    const scoreIndex = columnNames.indexOf("score");

    // `data` is built dynamically, so T is the caller's unchecked assertion.
    const results: SearchResult<T>[] = raw.result.data_array.map((row) => {
      const data: Record<string, unknown> = {};
      for (let i = 0; i < columnNames.length; i++) {
        if (i !== scoreIndex) data[columnNames[i]] = row[i];
      }
      return {
        score: scoreIndex >= 0 ? (row[scoreIndex] as number) : 0,
        data: data as T,
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
    // Match Plugin.execute(): the raw message is only exposed outside production.
    const isDev = process.env.NODE_ENV !== "production";
    const message =
      isDev && error instanceof Error ? error.message : fallbackMessage;
    res.status(500).json({ error: message, plugin: this.name });
  }
}

export const aiSearch = toPlugin(AiSearchPlugin);
