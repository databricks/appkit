import type { sql, WorkspaceClient } from "@databricks/sdk-experimental";
import type express from "express";
import type {
  AgentToolDefinition,
  IAppRouter,
  SQLTypeMarker,
  ToolProvider,
} from "shared";
import { z } from "zod";
import { SQLWarehouseConnector } from "../../connectors";
import {
  getCurrentUserContext,
  getCurrentUserId,
  getWarehouseId,
  getWorkspaceClient,
  isInUserContext,
  runInUserContext,
} from "../../context";
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
import { type TypedTaskContext, userContextFromTaskCtx } from "../../tasks";
import manifest from "./manifest.json";
import { QueryProcessor } from "./query";
import type {
  AnalyticsQueryResponse,
  IAnalyticsConfig,
  IAnalyticsQueryRequest,
} from "./types";

const logger = createLogger("analytics");

/**
 * Input for the durable `analytics:query` task. Every field participates
 * in the engine-derived IK, so the SP/OBO discriminator (`executorKey`,
 * `isAsUser`) and `formatType` must live here to keep dedup correct.
 */
interface AnalyticsQueryTaskInput {
  queryKey: string;
  statement: string;
  parameters?: Record<string, SQLTypeMarker | null | undefined>;
  formatParameters?: Record<string, unknown>;
  executorKey: string;
  isAsUser: boolean;
  formatType: "arrow" | "result";
}

/** Flat shape mirroring the legacy `response.result`: `{ statement_id, status }` for Arrow, `{ ...rest, data }` for JSON, or `null`. */
type AnalyticsQueryTaskResult = Record<string, unknown> | null;

/**
 * Typed `ctx.emit` map. Each key becomes the SSE `event:` name on the wire.
 * - `data`: terminal frame the client renders.
 * - `statement_submitted`: WAL checkpoint so recovery can re-attach.
 * - `recovered`: signals revival, with or without re-attach.
 */
interface AnalyticsTaskEvents extends Record<string, unknown> {
  data: { type: "arrow" | "result"; [k: string]: unknown };
  statement_submitted: {
    statement_id: string;
    status?: sql.StatementStatus["state"];
  };
  recovered: { reattach: true; statement_id: string } | { reattach: false };
}

export class AnalyticsPlugin extends Plugin implements ToolProvider {
  /** Plugin manifest declaring metadata and resource requirements */
  static manifest = manifest as PluginManifest<"analytics">;

  protected static description = "Analytics plugin for data analysis";
  protected declare config: IAnalyticsConfig;

  // analytics services
  private SQLClient: SQLWarehouseConnector;
  private queryProcessor: QueryProcessor;

  /** Plugin-scoped task name so multi-instance setups don't collide. */
  private get queryTaskName(): string {
    return `${this.name}:query`;
  }

  constructor(config: IAnalyticsConfig) {
    super(config);
    this.config = config;
    this.queryProcessor = new QueryProcessor();

    this.SQLClient = new SQLWarehouseConnector({
      timeout: config.timeout,
      telemetry: config.telemetry,
    });
  }

  /**
   * Register the durable `analytics:<name>:query` task. No-op when
   * TaskFlow is opted out; {@link query} falls back to the direct path.
   *
   * `autoRecover: false` because OBO recovery needs a fresh request:
   * callers revive via `this.task.resume(ik, { context: req })`.
   */
  async setup(): Promise<void> {
    if (!this.task) {
      logger.debug("TaskFlow disabled; analytics will use the direct path.");
      return;
    }
    this.task.task<
      AnalyticsQueryTaskInput,
      AnalyticsQueryTaskResult,
      AnalyticsTaskEvents
    >({
      name: this.queryTaskName,
      execute: (input, ctx) => this._runQueryTask(input, ctx),
      autoRecover: false,
    });
  }

  /**
   * Resolves SP vs OBO from `ctx.context`, then delegates to
   * {@link _runQueryInner}. OBO without a forwarded UserContext is a
   * hard error — silently falling back to SP would leak results across
   * users.
   */
  private async _runQueryTask(
    input: AnalyticsQueryTaskInput,
    ctx: TypedTaskContext<AnalyticsTaskEvents>,
  ): Promise<AnalyticsQueryTaskResult> {
    const userCtx = input.isAsUser ? userContextFromTaskCtx(ctx) : null;
    if (input.isAsUser && !userCtx) {
      throw new Error(
        "OBO analytics task ran without a UserContext. Pass `context: req` " +
          "to `this.task.resume(...)` from a fresh authenticated request, or " +
          "invoke via `appkit.<plugin>.asUser(req)` so the bridge captures " +
          "it. Falling back to the service principal would leak results.",
      );
    }
    if (userCtx) {
      return runInUserContext(userCtx, () => this._runQueryInner(input, ctx));
    }
    return this._runQueryInner(input, ctx);
  }

  private async _runQueryInner(
    input: AnalyticsQueryTaskInput,
    ctx: TypedTaskContext<AnalyticsTaskEvents>,
  ): Promise<AnalyticsQueryTaskResult> {
    const wsClient = getWorkspaceClient();
    const warehouseId = await getWarehouseId();

    if (ctx.isRecovery) {
      const events = Array.isArray(ctx.previousEvents)
        ? ctx.previousEvents
        : [];
      let submitted: (typeof events)[number] | undefined;
      for (let i = events.length - 1; i >= 0; i--) {
        const evt = events[i];
        if (evt?.eventType === "custom:statement_submitted") {
          submitted = evt;
          break;
        }
      }
      const statementId =
        submitted?.payload && typeof submitted.payload === "object"
          ? (submitted.payload as { statement_id?: string }).statement_id
          : undefined;
      if (statementId) {
        logger.info(
          "[analytics:task] RECOVERY REATTACH — polling existing statement_id=%s (no resubmit to warehouse)",
          statementId,
        );
        await ctx.emit("recovered", {
          reattach: true,
          statement_id: statementId,
        });
        const raw = await this.SQLClient.pollStatement(wsClient, statementId);
        const flat = AnalyticsPlugin._flattenStatementResult(raw);
        await this._emitDataFrame(ctx, input, flat);
        return flat;
      }
      logger.warn(
        "[analytics:task] RECOVERY FALLBACK — no statement_submitted checkpoint in previousEvents; re-executing from scratch",
      );
      // Crashed before the checkpoint landed — re-execute.
      await ctx.emit("recovered", { reattach: false });
    }

    const { statement, parameters: sqlParameters } =
      this.queryProcessor.convertToSQLParameters(
        input.statement,
        input.parameters,
      );

    // Force early-return so the WAL checkpoint lands before a long
    // query finishes. Without this, the connector's default
    // `wait_timeout: 30s` makes Statement Execution API hold the
    // connection until the query completes (when <30s), collapsing the
    // crash-recovery window. `on_wait_timeout: CONTINUE` keeps the
    // statement running on the warehouse so the recovery poll can
    // reattach by `statement_id`.
    const submitStart = Date.now();
    const submission = await this.SQLClient.submitStatement(wsClient, {
      statement,
      warehouse_id: warehouseId,
      parameters: sqlParameters,
      wait_timeout: "5s",
      on_wait_timeout: "CONTINUE",
      ...(input.formatParameters as Partial<sql.ExecuteStatementRequest>),
    });
    const statementId = submission.statement_id as string;
    logger.info(
      "[analytics:task] statement submitted statement_id=%s elapsed_ms=%d state=%s",
      statementId,
      Date.now() - submitStart,
      submission.status?.state,
    );
    await ctx.emit("statement_submitted", {
      statement_id: statementId,
      status: submission.status?.state,
    });

    const raw =
      submission.status?.state === "SUCCEEDED"
        ? this.SQLClient.transformResult(submission)
        : await this.SQLClient.pollStatement(wsClient, statementId);
    const flat = AnalyticsPlugin._flattenStatementResult(raw);
    await this._emitDataFrame(ctx, input, flat);
    return flat;
  }

  /**
   * Unwraps `.result` so SSE and programmatic callers see the same flat
   * shape as the legacy direct path. Returns `null` for DDL/DML with no
   * result body.
   */
  private static _flattenStatementResult(
    raw: sql.StatementResponse | { result: unknown },
  ): AnalyticsQueryTaskResult {
    if (raw && typeof raw === "object" && "result" in raw) {
      const inner = (raw as { result: unknown }).result;
      if (inner && typeof inner === "object" && !Array.isArray(inner)) {
        return inner as Record<string, unknown>;
      }
    }
    return null;
  }

  /**
   * Emits the terminal `data` frame in the flat shape the analytics
   * client expects (`{ type, ...flat }`). The engine's own `completed`
   * frame wraps the handler return — clients read this one instead.
   */
  private async _emitDataFrame(
    ctx: TypedTaskContext<AnalyticsTaskEvents>,
    input: AnalyticsQueryTaskInput,
    flat: AnalyticsQueryTaskResult,
  ): Promise<void> {
    const body: AnalyticsTaskEvents["data"] = {
      type: input.formatType,
      ...(flat ?? {}),
    };
    await ctx.emit("data", body);
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
   * When called via asUser(req), uses the user's Databricks credentials.
   */
  async _handleArrowRoute(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    try {
      const { jobId } = req.params;
      const workspaceClient = getWorkspaceClient();

      logger.debug("Processing Arrow job request for jobId=%s", jobId);

      const event = logger.event(req);
      event?.setComponent("analytics", "getArrowData").setContext("analytics", {
        job_id: jobId,
        plugin: this.name,
      });

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
   * Handle SQL query execution requests.
   * When called via asUser(req), uses the user's Databricks credentials.
   */
  async _handleQueryRoute(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const { query_key } = req.params;
    const {
      parameters,
      format = "JSON",
      direct = false,
    } = req.body as IAnalyticsQueryRequest;

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
    const executorKey = isAsUser ? this.resolveUserId(req) : "global";

    const isArrow = format === "ARROW";
    const formatParametersForRequest = isArrow
      ? { disposition: "EXTERNAL_LINKS", format: "ARROW_STREAM" }
      : undefined;
    const formatType: "arrow" | "result" = isArrow ? "arrow" : "result";

    const processedParams = await this.queryProcessor.processQueryParams(
      query,
      parameters,
    );

    // OBO goes through the `asUser(req)` proxy so `executeTask` runs
    // inside `runInUserContext` and the bridge forwards the user to the
    // engine sidecar.
    const target = isAsUser ? this.asUser(req) : this;

    // `direct: true` opts out for hot paths where the WAL + spawn
    // overhead dominates a sub-500ms query. Auto-falls-through when
    // TaskFlow is disabled at boot.
    if (direct || !this.task) {
      await this._handleDirectQueryRoute(req, res, target as this, {
        query,
        processedParams,
        formatParametersForRequest,
        formatType,
        isAsUser,
      });
      return;
    }

    // Warehouse statements are externally visible work: duplicate
    // submission changes cost and breaks crash-recovery reattach.
    // Storage-backed dedup is worth the small submit latency here.
    await target.executeTask<AnalyticsQueryTaskInput>(
      res,
      this.queryTaskName,
      {
        queryKey: query_key,
        statement: query,
        parameters: processedParams,
        formatParameters: formatParametersForRequest,
        executorKey,
        isAsUser,
        formatType,
      },
      {
        executeMode: "at_most_once",
        maxAttempts: 1,
      },
    );
  }

  /**
   * Bypasses TaskFlow but emits the same `{ type, ...flat }` payload as
   * the durable path. No IK, no recovery, no dedup — one-shot.
   */
  private async _handleDirectQueryRoute(
    _req: express.Request,
    res: express.Response,
    target: this,
    args: {
      query: string;
      processedParams: Record<string, SQLTypeMarker | null | undefined>;
      formatParametersForRequest: Record<string, unknown> | undefined;
      formatType: "arrow" | "result";
      isAsUser: boolean;
    },
  ): Promise<void> {
    const flat = await target._queryDirect(
      args.query,
      args.processedParams,
      args.formatParametersForRequest,
    );
    const body = {
      type: args.formatType,
      ...((flat as Record<string, unknown> | null | undefined) ?? {}),
    };
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).json(body);
  }

  /**
   * Execute a SQL query. Defaults to the durable TaskFlow path
   * (statement+params+format+executor dedup, crash-recovery via the
   * persisted `statement_submitted` checkpoint). Falls back to the
   * direct path when `options.direct` or when TaskFlow is opted out.
   *
   * Identity is the active execution context: SP by default, the
   * caller's user when invoked via `asUser(req).query(...)`.
   *
   * @example
   * ```typescript
   * await analytics.query("SELECT * FROM table");                 // SP
   * await this.asUser(req).query("SELECT * FROM table");          // OBO
   * ```
   */
  async query(
    query: string,
    parameters?: Record<string, SQLTypeMarker | null | undefined>,
    formatParameters?: Record<string, any>,
    signal?: AbortSignal,
    options?: { direct?: boolean },
  ): Promise<any> {
    if (options?.direct || !this.task) {
      return this._queryDirect(query, parameters, formatParameters, signal);
    }

    const isAsUser = isInUserContext();
    // `executorKey` shape MUST match `_handleQueryRoute`: same logical
    // query through HTTP and the programmatic API has to produce the
    // same IK, otherwise dedup breaks across entrypoints.
    const executorKey = isAsUser ? getCurrentUserId() : "global";
    const formatType: "arrow" | "result" =
      formatParameters?.disposition === "EXTERNAL_LINKS" ? "arrow" : "result";
    const input: AnalyticsQueryTaskInput = {
      queryKey: "programmatic",
      statement: query,
      parameters,
      formatParameters,
      executorKey,
      isAsUser,
      formatType,
    };

    // OBO: forward the live UserContext via the engine sidecar so the
    // handler can re-enter `runInUserContext` without re-parsing headers.
    // SP uses the same storage-backed dedup to avoid duplicate warehouse work.
    const handle = await this.task.start(this.queryTaskName, input, {
      userId: isAsUser ? executorKey : undefined,
      context: getCurrentUserContext() ?? undefined,
      executeMode: "at_most_once",
      maxAttempts: 1,
    });

    for await (const evt of this.task.subscribe(handle.idempotencyKey)) {
      if (signal?.aborted) {
        // Best-effort cooperative stop; engine owns the final state.
        await this.task
          .stop(handle.idempotencyKey, {
            reason: "client_aborted",
            userId: isAsUser ? executorKey : undefined,
          })
          .catch(() => {});
        throw ExecutionError.canceled();
      }
      const type = evt.event.eventType;
      if (type === "completed") {
        const payload = evt.event.payload as {
          result?: unknown;
        } | null;
        return payload?.result ?? payload;
      }
      if (type === "failed") {
        const message =
          (evt.event.payload as { error?: string } | null)?.error ??
          "task failed";
        throw ExecutionError.statementFailed(message);
      }
      if (type === "cancelled" || type === "suspended") {
        throw ExecutionError.canceled();
      }
    }
    throw ExecutionError.statementFailed(
      "Query stream closed without a terminal event",
    );
  }

  /** Direct path — single point of fallback when TaskFlow is opted out or `direct: true`. */
  private async _queryDirect(
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
 * @internal
 */
export const analytics = toPlugin(AnalyticsPlugin);
