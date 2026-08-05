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
import { formatWarningBanner } from "../../utils/banner";
import { aiSearchDefaults } from "./defaults";
import manifest from "./manifest.json";
import type {
  IAiSearchConfig,
  IndexConfig,
  IndexSummary,
  SearchQueryType,
  SearchRequest,
  SearchResponse,
  SearchResult,
} from "./types";

const logger = createLogger("ai-search");

const querySettings: PluginExecutionSettings = {
  default: aiSearchDefaults,
};

export class AiSearchPlugin extends Plugin<IAiSearchConfig> {
  static manifest = manifest as PluginManifest<"aiSearch">;

  protected static description =
    "Query Databricks Vector Search indexes with hybrid search, reranking, and pagination";
  protected declare config: IAiSearchConfig;

  private connector: AiSearchConnector;

  constructor(config: IAiSearchConfig) {
    super(config);
    this.config = {
      ...config,
      indexes: config.indexes ?? this._defaultIndexes(),
    };
    this.connector = new AiSearchConnector({
      timeout: config.timeout,
      telemetry: config.telemetry,
    });
  }

  /**
   * Seeds a `default` index from `DATABRICKS_VS_INDEX_NAME` when no `indexes`
   * are configured, so `aiSearch()` works with just the env var.
   */
  private _defaultIndexes(): Record<string, IndexConfig> {
    const indexName = process.env.DATABRICKS_VS_INDEX_NAME;
    return indexName ? { default: { indexName } } : {};
  }

  async setup(): Promise<void> {
    // pagination needs an endpointName the framework's resource validation
    // can't see, so check it here.
    for (const [alias, idx] of Object.entries(this.config.indexes ?? {})) {
      if (idx.pagination && !idx.endpointName) {
        throw new Error(
          `Index "${alias}" has pagination enabled but is missing "endpointName"`,
        );
      }
    }

    // Dev fills in missing `columns` from the source table; prod can't query
    // without them (VS requires `columns`), so fail fast at boot.
    if (process.env.NODE_ENV === "development") {
      await this._autoDiscoverColumns();
    } else {
      for (const [alias, idx] of Object.entries(this.config.indexes ?? {})) {
        if (!idx.columns || idx.columns.length === 0) {
          throw new Error(
            `Index "${alias}" has no columns configured. Vector Search queries require "columns"; set them explicitly (auto-discovered only in development).`,
          );
        }
      }
    }
  }

  /**
   * For each configured index missing `columns`, fill them from its Delta-Sync
   * source table (all source columns minus embedding vectors). Best-effort:
   * failures are logged and skipped, never thrown. A partial `columns_to_sync`
   * isn't honored, so the discovered list is a starting point to trim.
   */
  private async _autoDiscoverColumns(): Promise<void> {
    const discovered: Record<string, string[]> = {};
    for (const [alias, idx] of Object.entries(this.config.indexes ?? {})) {
      if (idx.columns && idx.columns.length > 0) continue;
      const indexName = idx.indexName ?? process.env.DATABRICKS_VS_INDEX_NAME;
      if (!indexName) continue;
      try {
        const client = getWorkspaceClient();
        const info = await this.connector.getIndex(client, indexName);
        const sourceTable = info.delta_sync_index_spec?.source_table;
        if (!sourceTable) continue;
        const excluded = new Set(
          (info.delta_sync_index_spec?.embedding_vector_columns ?? []).map(
            (c) => c.name,
          ),
        );
        const columns = (
          await this.connector.getSourceColumns(client, sourceTable)
        ).filter((c) => !excluded.has(c));
        if (columns.length > 0) {
          idx.columns = columns;
          discovered[alias] = columns;
        }
      } catch (error) {
        logger.warn(
          'Could not auto-discover columns for index "%s": %s',
          alias,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    if (Object.keys(discovered).length > 0) {
      logger.warn("\n%s", this._formatColumnDiscoveryBanner(discovered));
    }
  }

  private _formatColumnDiscoveryBanner(
    discovered: Record<string, string[]>,
  ): string {
    const lines = [
      "AI SEARCH: columns auto-discovered (dev mode — would fail in production)",
      "",
    ];
    for (const [alias, columns] of Object.entries(discovered)) {
      lines.push(`  ${alias}: ${columns.join(", ")}`);
    }
    lines.push("");
    lines.push(
      "Set `columns` explicitly in the plugin config before deploying.",
    );

    return formatWarningBanner(lines);
  }

  injectRoutes(router: IAppRouter) {
    this.route(router, {
      name: "query",
      method: "post",
      path: "/:alias/query",
      handler: async (req: express.Request, res: express.Response) => {
        const indexConfig = this._resolveOr404(req, res);
        if (!indexConfig) return;

        const body: SearchRequest = req.body;
        if (!body.queryText && !body.queryVector) {
          res.status(400).json({
            error: "queryText or queryVector is required",
            plugin: this.name,
          });
          return;
        }

        // Drop client-supplied `columns` so an HTTP caller can't widen the
        // projection past what the app configured. (query() callers are
        // trusted and keep the override.)
        const { columns: _clientColumns, ...safeBody } = body;
        const plugin =
          indexConfig.auth === "on-behalf-of-user" ? this.asUser(req) : this;
        const queryType =
          safeBody.queryType ?? indexConfig.queryType ?? "hybrid";

        try {
          // Prepare inside execute so a self-managed embeddingFn runs in the
          // same OBO context as the query, not as the service principal.
          const result = await plugin.execute(async (signal) => {
            const prepared = await this._prepareQuery(safeBody, indexConfig);
            return this.connector.query(
              getWorkspaceClient(),
              { indexName: indexConfig.indexName, ...prepared },
              signal,
            );
          }, querySettings);

          this._sendResult(res, result, queryType);
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
        const indexConfig = this._resolveOr404(req, res);
        if (!indexConfig) return;

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

        const { pageToken, queryType } = req.body;
        if (!pageToken) {
          res.status(400).json({
            error: "pageToken is required",
            plugin: this.name,
          });
          return;
        }
        // Echo the original query's queryType so paged responses stay
        // consistent with page 1; fall back to the index default.
        const pageQueryType = queryType ?? indexConfig.queryType ?? "hybrid";

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

          this._sendResult(res, result, pageQueryType);
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
        const indexConfig = this._resolveOr404(req, res);
        if (!indexConfig) return;
        res.json({
          alias: req.params.alias,
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
   * Index aliases + non-sensitive query metadata, serialized to the client so
   * the UI can discover available indexes instead of hardcoding an alias.
   */
  clientConfig(): { indexes: IndexSummary[] } {
    const indexes = Object.entries(this.config.indexes ?? {}).map(
      ([alias, idx]) => ({
        alias,
        queryType: idx.queryType ?? "hybrid",
        pagination: !!idx.pagination,
      }),
    );
    return { indexes };
  }

  /**
   * Programmatic query API — available as `appkit.aiSearch.query()`.
   * When called through `asUser(req)`, executes with the user's credentials.
   *
   * @remarks `T` types each result's `data` but is an unchecked cast — the row
   * shape isn't validated at runtime.
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

  private _resolveIndex(
    alias: string,
  ): (IndexConfig & { indexName: string }) | undefined {
    const idx = this.config.indexes?.[alias];
    if (!idx) return undefined;
    const indexName = idx.indexName ?? process.env.DATABRICKS_VS_INDEX_NAME;
    if (!indexName) return undefined;
    return { ...idx, indexName };
  }

  /** Resolve an index by route alias, or send a 404 and return null. */
  private _resolveOr404(
    req: express.Request,
    res: express.Response,
  ): (IndexConfig & { indexName: string }) | null {
    const indexConfig = this._resolveIndex(req.params.alias);
    if (!indexConfig) {
      res.status(404).json({
        error: `No index configured with alias "${req.params.alias}"`,
        plugin: this.name,
      });
      return null;
    }
    return indexConfig;
  }

  /** Send an execution result as JSON, or its error status/message. */
  private _sendResult(
    res: express.Response,
    result: Awaited<ReturnType<typeof this.execute<VsRawResponse>>>,
    queryType: SearchQueryType,
  ): void {
    if (!result.ok) {
      res
        .status(result.status)
        .json({ error: result.message, plugin: this.name });
      return;
    }
    res.json(this._parseResponse(result.data, queryType));
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

    const columns = request.columns ?? indexConfig.columns ?? [];
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
    // Auto-derive from returnable columns (excluding the id). With no columns
    // resolved there's nothing to rerank on, so skip it.
    const columnsToRerank = columns.filter((c) => c !== "id");
    return columnsToRerank.length > 0 ? { columnsToRerank } : undefined;
  }

  private _parseResponse<
    T extends Record<string, unknown> = Record<string, unknown>,
  >(raw: VsRawResponse, queryType: SearchQueryType): SearchResponse<T> {
    const columnNames = raw.manifest.columns.map((c) => c.name);
    const scoreIndex = columnNames.indexOf("score");

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
