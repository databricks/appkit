import type { WorkspaceClient } from "@databricks/sdk-experimental";
import { tableFromIPC } from "apache-arrow";
import type express from "express";
import {
  type AgentToolDefinition,
  type AnalyticsSseMessage,
  type IAppRouter,
  makeArrowMessage,
  makeResultMessage,
  type PluginExecuteConfig,
  type SQLTypeMarker,
  type StreamExecutionSettings,
  type ToolProvider,
} from "shared";
import { z } from "zod";
import { SQLWarehouseConnector } from "../../connectors";
import { getWarehouseId, getWorkspaceClient } from "../../context";
import { buildToolkitEntries } from "../../core/agent/build-toolkit";
import {
  defineTool,
  executeFromRegistry,
  toolsFromRegistry,
} from "../../core/agent/tools/define-tool";
import { assertReadOnlySql } from "../../core/agent/tools/sql-policy";
import { ExecutionError } from "../../errors";
import { createLogger } from "../../logging/logger";
import { Plugin, toPlugin } from "../../plugin";
import type { PluginManifest } from "../../registry";
import { queryDefaults } from "./defaults";
import { InlineArrowStash } from "./inline-arrow-stash";
import manifest from "./manifest.json";
import { QueryProcessor } from "./query";
import {
  type AnalyticsFormat,
  type AnalyticsQueryResponse,
  type IAnalyticsConfig,
  type IAnalyticsQueryRequest,
  normalizeAnalyticsFormat,
} from "./types";

const logger = createLogger("analytics");

export class AnalyticsPlugin extends Plugin implements ToolProvider {
  /** Plugin manifest declaring metadata and resource requirements */
  static manifest = manifest as PluginManifest<"analytics">;

  protected static description = "Analytics plugin for data analysis";
  protected declare config: IAnalyticsConfig;

  // analytics services
  private SQLClient: SQLWarehouseConnector;
  private queryProcessor: QueryProcessor;

  /**
   * Server-side stash for inline Arrow IPC payloads.
   *
   * INLINE ARROW_STREAM responses do not ride the SSE control channel —
   * the route puts the decoded bytes here and emits an `arrow` SSE
   * message with a synthetic `inline-<uuid>` id, and the client fetches
   * the bytes through the existing `/arrow-result/:jobId` endpoint with
   * a real binary content-type.
   */
  // Short put-wait so that a momentarily full stash backpressures rather
  // than immediately falling back to EXTERNAL_LINKS — important on
  // warehouses (e.g. Reyden) that refuse EXTERNAL_LINKS outright. The
  // stash is drain-on-read, so an in-flight `/arrow-result` GET from any
  // concurrent query usually frees a slot well within this window. True
  // sustained overload still falls back via the existing path below.
  protected inlineArrowStash: InlineArrowStash = new InlineArrowStash({
    putWaitMs: 500,
  });

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
    // Arrow data downloads always run as service principal and bypass the
    // interceptor chain (execute/executeStream). The original query execution
    // handles OBO via executeStream(); this endpoint fetches pre-computed
    // results by job ID.
    this.route(router, {
      name: "arrow",
      method: "get",
      path: "/arrow-result/:jobId",
      handler: async (req: express.Request, res: express.Response) => {
        await this._handleArrowRoute(req, res);
      },
    });

    this.route<AnalyticsQueryResponse>(router, {
      name: "query",
      method: "post",
      path: "/query/:query_key",
      handler: async (req: express.Request, res: express.Response) => {
        await this._handleQueryRoute(req, res);
      },
    });
  }

  /**
   * Handle Arrow data download requests.
   *
   * Two id shapes are supported:
   * - `inline-<uuid>`: bytes were stashed server-side by the query route.
   *   Drain the stash, serve directly with the canonical Arrow content
   *   type. No warehouse round-trip.
   * - any other id: a warehouse-issued statement id. Fetch the Arrow
   *   stream from the warehouse via the SDK; serve the bytes.
   *
   * When called via asUser(req), uses the user's Databricks credentials
   * for the warehouse path. The inline path is user-scoped at the stash
   * layer instead.
   */
  async _handleArrowRoute(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const { jobId } = req.params;
    const event = logger.event(req);
    event?.setComponent("analytics", "getArrowData").setContext("analytics", {
      job_id: jobId,
      plugin: this.name,
    });

    if (jobId.startsWith("inline-")) {
      const userKey = this._stashUserKey(req);
      const bytes = this.inlineArrowStash.take(jobId, userKey);
      if (!bytes) {
        // Already drained, expired, or never belonged to this user. 410
        // distinguishes this from "warehouse statement id not found" (404)
        // so the client can surface a useful error.
        logger.debug("Inline Arrow stash miss for jobId=%s", jobId);
        res.status(410).json({
          error: "Inline Arrow result expired or unknown",
          plugin: this.name,
        });
        return;
      }
      logger.debug(
        "Serving inline Arrow buffer: %d bytes for jobId=%s",
        bytes.length,
        jobId,
      );
      res.setHeader("Content-Type", "application/vnd.apache.arrow.stream");
      res.setHeader("Content-Length", bytes.length.toString());
      // Inline payloads are single-use and short-lived; no public caching.
      res.setHeader("Cache-Control", "no-store");
      res.send(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      return;
    }

    try {
      const workspaceClient = getWorkspaceClient();
      logger.debug("Processing Arrow job request for jobId=%s", jobId);

      const result = await this.getArrowData(workspaceClient, jobId);

      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Length", result.data.length.toString());
      res.setHeader("Cache-Control", "public, max-age=3600");

      logger.debug(
        "Sending Arrow buffer: %d bytes for job %s",
        result.data.length,
        jobId,
      );
      res.send(Buffer.from(result.data));
    } catch (error) {
      logger.error("Arrow job error: %O", error);
      res.status(404).json({
        error: error instanceof Error ? error.message : "Arrow job not found",
        plugin: this.name,
      });
    }
  }

  /**
   * Stash key used at put-time (in `_handleQueryRoute`) and take-time
   * (in `_handleArrowRoute`). Centralized so the two sides cannot drift.
   *
   * Returns the user id when an `x-forwarded-user` header is present,
   * otherwise `"global"` for service-principal contexts (no user header).
   * Both queries from the same request resolve to the same key, so the
   * subsequent /arrow-result fetch reliably hits the entry stashed
   * during the SSE query.
   *
   * `resolveUserId` throws when no header is present — catch and degrade
   * to "global" rather than letting that failure mode bubble through the
   * route handler.
   */
  protected _stashUserKey(req: express.Request): string {
    try {
      return this.resolveUserId(req) || "global";
    } catch {
      return "global";
    }
  }

  /**
   * Handle SQL query execution requests.
   * When called via asUser(req), uses the user's Databricks credentials.
   */
  async _handleQueryRoute(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const { query_key } = req.params;
    const { parameters, format: rawFormat = "JSON_ARRAY" } =
      req.body as IAnalyticsQueryRequest;

    if (
      rawFormat !== "JSON_ARRAY" &&
      rawFormat !== "ARROW_STREAM" &&
      rawFormat !== "JSON" &&
      rawFormat !== "ARROW"
    ) {
      res.status(400).json({
        error: `Invalid format: ${String(rawFormat)}. Expected "JSON_ARRAY" or "ARROW_STREAM".`,
      });
      return;
    }

    const format = normalizeAnalyticsFormat(rawFormat);

    // Request-scoped logging with WideEvent tracking
    logger.debug(req, "Executing query: %s (format=%s)", query_key, format);

    const event = logger.event(req);
    event?.setComponent("analytics", "executeQuery").setContext("analytics", {
      query_key,
      format,
      parameter_count: parameters ? Object.keys(parameters).length : 0,
      plugin: this.name,
    });

    if (!query_key) {
      res.status(400).json({ error: "query_key is required" });
      return;
    }

    const queryResult = await this.app.getAppQuery(
      query_key,
      req,
      this.devFileReader,
    );

    if (!queryResult) {
      res.status(404).json({ error: "Query not found" });
      return;
    }

    const { query, isAsUser } = queryResult;

    // get execution context - user-scoped if .obo.sql, otherwise service principal
    const executor = isAsUser ? this.asUser(req) : this;
    const executorKey = isAsUser ? this.resolveUserId(req) : "global";
    // Stash key is always per-request user (never "global"), independent
    // of the executor's cache scope. Inline Arrow payloads are single-use
    // and short-lived — there is no benefit to sharing them across users,
    // and per-user scoping is defense in depth on top of unguessable ids.
    const stashUserKey = this._stashUserKey(req);

    const hashedQuery = this.queryProcessor.hashQuery(query);

    // ARROW_STREAM responses reference ephemeral resources that cannot be
    // safely replayed from cache:
    // - EXTERNAL_LINKS pre-signed URLs expire ~15 min after issue, and
    //   the warehouse rotates them per execution.
    // - INLINE responses point at a synthetic `inline-<uuid>` job id
    //   backed by `InlineArrowStash`, which drains on the first
    //   /arrow-result fetch. A cache hit would replay an id whose bytes
    //   are already gone and reliably 410 the client.
    // So we bypass cache for ARROW_STREAM and let every request execute
    // a fresh statement. JSON_ARRAY responses still cache normally.
    const cacheTtl = format === "ARROW_STREAM" ? 0 : queryDefaults.cache?.ttl;
    const cacheConfig = {
      ...queryDefaults.cache,
      ttl: cacheTtl,
      cacheKey: [
        "analytics:query",
        query_key,
        JSON.stringify(parameters),
        format,
        hashedQuery,
        executorKey,
      ],
    };

    const defaultConfig: PluginExecuteConfig = {
      ...queryDefaults,
      cache: cacheConfig,
    };

    const streamExecutionSettings: StreamExecutionSettings = {
      default: defaultConfig,
    };

    await executor.executeStream(
      res,
      async (signal) => {
        const processedParams = await this.queryProcessor.processQueryParams(
          query,
          parameters,
        );

        return this._executeWithFormatFallback(
          executor,
          query,
          processedParams,
          format,
          stashUserKey,
          signal,
        );
      },
      streamExecutionSettings,
      executorKey,
    );
  }

  /**
   * Execute a query with automatic disposition/format fallback.
   *
   * - **JSON_ARRAY** first tries `INLINE + JSON_ARRAY`. If the warehouse
   *   only supports `ARROW_STREAM` for `INLINE` (some serverless variants),
   *   retries as `INLINE + ARROW_STREAM`, decodes the Arrow IPC attachment
   *   server-side, and returns plain row objects — the caller's
   *   `JSON_ARRAY` contract is preserved.
   * - **ARROW_STREAM** first tries `INLINE + ARROW_STREAM`. If the
   *   warehouse refuses (most classic + some serverless variants), or the
   *   inline stash is full after a brief backpressure wait, falls back to
   *   `EXTERNAL_LINKS + ARROW_STREAM`.
   *
   * INLINE Arrow attachments under the ARROW_STREAM path are decoded once
   * and put on the plugin's `inlineArrowStash`; the SSE message carries the
   * synthetic stash id so the client fetches the bytes out-of-band via
   * `/arrow-result/<id>`.
   */
  private async _executeWithFormatFallback(
    executor: AnalyticsPlugin,
    query: string,
    processedParams:
      | Record<string, SQLTypeMarker | null | undefined>
      | undefined,
    requestedFormat: AnalyticsFormat,
    stashUserKey: string,
    signal?: AbortSignal,
  ): Promise<AnalyticsSseMessage> {
    if (requestedFormat === "JSON_ARRAY") {
      try {
        const result = await executor.query(
          query,
          processedParams,
          { disposition: "INLINE", format: "JSON_ARRAY" },
          signal,
        );
        return makeResultMessage(result?.data, {
          status: result?.status,
          statement_id: result?.statement_id,
        });
      } catch (err: unknown) {
        if (signal?.aborted) throw err;
        if (_classifyInlineRejection(err) !== "needs-arrow") throw err;

        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          "JSON_ARRAY INLINE rejected by warehouse, retrying as ARROW_STREAM INLINE and decoding server-side: %s",
          msg,
        );
      }

      // Retry as ARROW_STREAM + INLINE so the warehouse will accept the
      // request, then decode the Arrow IPC attachment to plain row
      // objects so the caller still gets JSON_ARRAY-shaped data.
      const arrowResult = await executor.query(
        query,
        processedParams,
        { disposition: "INLINE", format: "ARROW_STREAM" },
        signal,
      );
      if (!arrowResult?.attachment) {
        throw ExecutionError.missingData("ARROW_STREAM attachment");
      }
      const rows = decodeArrowAttachmentToRows(arrowResult.attachment);
      return makeResultMessage(rows, {
        status: arrowResult.status,
        statement_id: arrowResult.statement_id,
      });
    }

    // ARROW_STREAM: try INLINE first, fall back to EXTERNAL_LINKS.
    try {
      const result = await executor.query(
        query,
        processedParams,
        { disposition: "INLINE", format: "ARROW_STREAM" },
        signal,
      );
      // INLINE responses with an Arrow IPC attachment go through the
      // stash-and-serve path: decode the base64 once, hold the bytes
      // server-side, emit a synthetic statement id. The client fetches via
      // /arrow-result so multi-MiB Arrow blobs never traverse SSE.
      if (result?.attachment) {
        // If the client has already disconnected, the SSE write would be
        // dropped anyway — skip the decode + stash so the bytes do not
        // linger in memory until TTL eviction.
        if (signal?.aborted) {
          throw ExecutionError.canceled();
        }
        const decoded = Buffer.from(result.attachment, "base64");
        const inlineId = await this.inlineArrowStash.putBlocking(
          stashUserKey,
          new Uint8Array(
            decoded.buffer,
            decoded.byteOffset,
            decoded.byteLength,
          ),
          signal,
        );
        if (inlineId === null) {
          // Stash is full even after the put-wait elapsed — every id we
          // have already handed out must stay valid, so the stash refuses
          // new entries rather than evicting in-flight ones. Fall back to
          // EXTERNAL_LINKS for this request so the client still gets its
          // result. On warehouses that refuse EXTERNAL_LINKS (e.g. Reyden)
          // the executor will surface NOT_IMPLEMENTED to the caller.
          logger.warn(
            "Inline Arrow stash full after put-wait, falling back to EXTERNAL_LINKS for the current query",
          );
        } else {
          return makeArrowMessage(inlineId, { status: result.status });
        }
      } else {
        return makeResultMessage(result?.data, {
          status: result?.status,
          statement_id: result?.statement_id,
        });
      }
    } catch (err: unknown) {
      // If the request was aborted, do not retry — the signal is dead and
      // a second statement would be billed but never read.
      if (signal?.aborted) {
        throw err;
      }

      if (_classifyInlineRejection(err) !== "needs-json") {
        throw err;
      }

      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        "ARROW_STREAM INLINE rejected by warehouse, falling back to EXTERNAL_LINKS: %s",
        msg,
      );
    }

    const result = await executor.query(
      query,
      processedParams,
      { disposition: "EXTERNAL_LINKS", format: "ARROW_STREAM" },
      signal,
    );
    return makeArrowMessage(result.statement_id, { status: result.status });
  }

  /**
   * Execute a SQL query using the current execution context.
   *
   * When called directly: uses service principal credentials.
   * When called via asUser(req).query(...): uses user's credentials.
   *
   * @example
   * ```typescript
   * // Service principal execution
   * const result = await analytics.query("SELECT * FROM table")
   *
   * // User context execution (in route handler)
   * const result = await this.asUser(req).query("SELECT * FROM table")
   * ```
   */
  async query(
    query: string,
    parameters?: Record<string, SQLTypeMarker | null | undefined>,
    formatParameters?: Record<string, any>,
    signal?: AbortSignal,
  ): Promise<any> {
    const workspaceClient = getWorkspaceClient();
    const warehouseId = await getWarehouseId();

    const { statement, parameters: sqlParameters } =
      this.queryProcessor.convertToSQLParameters(query, parameters);

    const response = await this.SQLClient.executeStatement(
      workspaceClient,
      {
        statement,
        warehouse_id: warehouseId,
        parameters: sqlParameters,
        ...formatParameters,
      },
      signal,
    );

    return response.result;
  }

  /**
   * Get Arrow-formatted data for a completed query job.
   */
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

  private tools = {
    query: defineTool({
      description:
        "Execute a read-only SQL query against the Databricks SQL warehouse. Only SELECT, WITH, SHOW, EXPLAIN, and DESCRIBE statements are accepted; writes are rejected. Returns the query results as JSON.",
      schema: z.object({
        query: z
          .string()
          .describe(
            "The SQL query to execute. Must be a SELECT, WITH, SHOW, EXPLAIN, or DESCRIBE statement.",
          ),
      }),
      annotations: {
        effect: "read",
        requiresUserContext: true,
      },
      autoInheritable: true,
      execute: (args, signal) => {
        assertReadOnlySql(args.query);
        return this.query(args.query, undefined, undefined, signal);
      },
    }),
  };

  getAgentTools(): AgentToolDefinition[] {
    return toolsFromRegistry(this.tools);
  }

  async executeAgentTool(
    name: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return executeFromRegistry(this.tools, name, args, signal);
  }

  /**
   * Returns the plugin's tools as a keyed record of `ToolkitEntry` markers.
   * Called by the agents plugin (via `resolveToolkitFromProvider`) to spread
   * a filtered, renamed view of the plugin's tools into an agent's tool
   * index. Inside the function form of `AgentDefinition.tools`, callers
   * reach this method via `plugins.analytics.toolkit(opts)`.
   */
  toolkit(opts?: import("../../core/agent/types").ToolkitOptions) {
    return buildToolkitEntries(this.name, this.tools, opts);
  }

  /**
   * Returns the public exports for the analytics plugin.
   * Note: `asUser()` is automatically added by AppKit.
   */
  exports() {
    return {
      /**
       * Execute a SQL query using service principal credentials.
       */
      query: this.query,
    };
  }
}

/**
 * Decode a base64 Arrow IPC attachment to plain row objects.
 *
 * Used by the JSON_ARRAY fallback path when a warehouse refuses
 * `JSON_ARRAY + INLINE` and we have to satisfy the request via
 * `ARROW_STREAM + INLINE` — the bytes come back as Arrow IPC but the
 * caller's contract is JSON-shaped rows, so we convert server-side.
 *
 * Scalar values are stringified to match what the warehouse itself emits
 * for INT/BIGINT/etc. columns under the JSON_ARRAY format (everything in
 * `result.data_array` is a string on the wire) — so callers see the same
 * row shape regardless of which path the bytes took. BigInts get the same
 * stringification treatment (also necessary for JSON-serializability).
 */
function decodeArrowAttachmentToRows(
  attachment: string,
): Record<string, unknown>[] {
  const decoded = Buffer.from(attachment, "base64");
  const table = tableFromIPC(
    new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength),
  );
  const colNames = table.schema.fields.map((f) => f.name);
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < table.numRows; i++) {
    const row: Record<string, unknown> = {};
    for (const name of colNames) {
      const col = table.getChild(name);
      const v = col?.get(i);
      if (v == null) {
        row[name] = null;
      } else if (
        typeof v === "number" ||
        typeof v === "bigint" ||
        typeof v === "boolean"
      ) {
        row[name] = String(v);
      } else if (typeof v === "string") {
        row[name] = v;
      } else {
        // Nested types (List, Struct, Map) — leave as-is. The JSON_ARRAY
        // wire format renders these as JSON strings server-side, but that
        // serialization isn't exposed to us here. Round-tripping through
        // JSON.stringify would mismatch, so pass the typed value through.
        row[name] = v;
      }
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Classify a warehouse rejection of an INLINE statement.
 *
 * Two distinct rejection modes are observed in the wild:
 *
 * - **needs-arrow**: warehouse refuses `JSON_ARRAY + INLINE`, only accepts
 *   `ARROW_STREAM + INLINE`. Example message:
 *   `"Inline disposition only supports ARROW_STREAM format."`
 *   Action: retry as `ARROW_STREAM + INLINE` and decode server-side.
 *
 * - **needs-json**: warehouse refuses `ARROW_STREAM + INLINE`, only accepts
 *   `JSON_ARRAY + INLINE`. Examples:
 *   `"The format field must be JSON_ARRAY when the disposition field is INLINE."`
 *   `"ARROW_STREAM not supported with INLINE disposition"`
 *   `"ExternalLinks disposition is not yet implemented."` (same family —
 *   the warehouse rejected the disposition/format combo we sent).
 *   Action: retry as `ARROW_STREAM + EXTERNAL_LINKS`.
 *
 * The structured `errorCode` (INVALID_PARAMETER_VALUE / NOT_IMPLEMENTED)
 * gates the classification so unrelated SQL errors don't trigger a retry.
 * Message matching is case-insensitive — warehouses are inconsistent about
 * casing of "Inline"/"INLINE".
 */
type InlineRejection = "needs-arrow" | "needs-json" | null;

function _classifyInlineRejection(err: unknown): InlineRejection {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

  const structuredCode =
    err instanceof ExecutionError ? err.errorCode : undefined;
  const hasCode =
    structuredCode === "INVALID_PARAMETER_VALUE" ||
    structuredCode === "NOT_IMPLEMENTED" ||
    lower.includes("invalid_parameter_value") ||
    lower.includes("not_implemented");
  if (!hasCode) return null;

  // Must mention the inline disposition to count as a disposition-rejection.
  if (!lower.includes("inline")) return null;

  // "needs-arrow": warehouse only supports ARROW_STREAM for INLINE.
  if (
    /only supports\s+arrow_stream/i.test(msg) ||
    /must be\s+arrow_stream/i.test(msg)
  ) {
    return "needs-arrow";
  }

  // "needs-json": warehouse only supports JSON_ARRAY for INLINE.
  if (
    /only supports\s+json_array/i.test(msg) ||
    /must be\s+json_array/i.test(msg) ||
    /arrow_stream\s+(is\s+|was\s+)?not\s+supported/i.test(msg)
  ) {
    return "needs-json";
  }

  return null;
}

/**
 * @internal
 */
export const analytics = toPlugin(AnalyticsPlugin);
