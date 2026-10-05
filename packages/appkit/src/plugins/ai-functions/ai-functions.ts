import type express from "express";
import type {
  AgentToolDefinition,
  AiFunctionsClientConfig,
  AiFunctionTask,
  AiFunctionTaskInput,
  AiFunctionTaskResult,
  ClassifyLabel,
  ClassifyLabels,
  ClassifyRequest,
  ClassifyResponse,
  DecideQuestions,
  DecideRequest,
  DecideResponse,
  ExtractRequest,
  ExtractResponse,
  ExtractResult,
  ExtractSchema,
  IAppRouter,
  PluginExecuteConfig,
  PluginExecutionSettings,
  ToolProvider,
} from "shared";
import { z } from "zod";

import {
  AiFunctionsConnector,
  AiFunctionsTransportError,
} from "../../connectors/ai-functions";
import { getCurrentActorId, getWorkspaceClient } from "../../context";
import {
  getCallerContext,
  isLegacyCallerScope,
  runOutsideCallerScope,
} from "../../context/execution-context";
import { buildToolkitEntries } from "../../core/agent/build-toolkit";
import {
  defineTool,
  executeFromRegistry,
  type ToolEntry,
  type ToolRegistry,
  toolsFromRegistry,
} from "../../core/agent/tools/define-tool";
import type { ToolkitOptions } from "../../core/agent/types";
import { AppKitError } from "../../errors/base";
import { ConfigurationError } from "../../errors/configuration";
import { ExecutionError } from "../../errors/execution";
import { createLogger } from "../../logging/logger";
import { type ExecutionResult, Plugin, toPlugin } from "../../plugin";
import { defineManifest } from "../../registry";
import type { WorkspaceClient } from "../../workspace-client";
import { aiFunctionsDefaults } from "./defaults";
import { AiFunctionsRequestError } from "./errors";
import manifest from "./manifest.json";
import {
  parseClassifyRequest,
  parseDecideRequest,
  parseExtractRequest,
  parseTaskInput,
} from "./schemas";
import {
  type AiFunctionName,
  type PreparedTask,
  prepareTask,
  TASK_NAME_PATTERN,
  TaskDefinitionError,
} from "./tasks";
import type { IAiFunctionsConfig } from "./types";

const logger = createLogger("ai-functions");

type ParsedRequest =
  | { function: "classify"; request: ClassifyRequest }
  | { function: "extract"; request: ExtractRequest }
  | { function: "decide"; request: DecideRequest };

type StoredTask = PreparedTask & { name: string };

/** Generated tool descriptions list at most 20 names, then "…". */
function listUpTo20(names: readonly string[]): string {
  return names.slice(0, 20).join(", ") + (names.length > 20 ? ", …" : "");
}

function combineSignals(
  ...signals: (AbortSignal | undefined)[]
): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  return present.length <= 1 ? present[0] : AbortSignal.any(present);
}

export class AiFunctionsPlugin
  extends Plugin<IAiFunctionsConfig>
  implements ToolProvider
{
  static manifest = defineManifest<"aiFunctions">(manifest);

  protected static description =
    "Call Databricks AI Functions for classification, extraction, and structured decisions";
  declare protected config: IAiFunctionsConfig;

  private readonly connector: AiFunctionsConnector;
  /** Validated tasks by name. A Map, so names can't collide with Object.prototype. */
  private readonly tasks = new Map<string, StoredTask>();
  /** Null-prototype, so model-supplied names like "constructor" miss cleanly. */
  private readonly tools: ToolRegistry = Object.create(null);

  constructor(config: IAiFunctionsConfig) {
    super(config);
    this.connector = new AiFunctionsConnector({ telemetry: config.telemetry });
    for (const [name, task] of Object.entries(config.tasks ?? {})) {
      this.tasks.set(name, { name, ...this.prepareConfiguredTask(name, task) });
    }
    if (this.tasks.size === 0) {
      logger.warn(
        "aiFunctions has no tasks configured; HTTP routes and agent tools are inactive",
      );
    }
    for (const stored of this.tasks.values()) {
      this.tools[`${stored.name}.invoke`] = this.defineTaskTool(stored);
    }
  }

  async classify<const L extends ClassifyLabels>(
    request: ClassifyRequest<L>,
  ): Promise<ClassifyResponse<ClassifyLabel<L>>> {
    const parsed = parseClassifyRequest(request);
    return this.unwrapResult(
      await this.executeParsed(
        { function: "classify", request: parsed },
        getWorkspaceClient,
      ),
      "classify",
    ) as ClassifyResponse<ClassifyLabel<L>>;
  }

  async extract<const S extends ExtractSchema>(
    request: ExtractRequest<S>,
  ): Promise<ExtractResponse<ExtractResult<S>>> {
    const parsed = parseExtractRequest(request);
    return this.unwrapResult(
      await this.executeParsed(
        { function: "extract", request: parsed },
        getWorkspaceClient,
      ),
      "extract",
    ) as ExtractResponse<ExtractResult<S>>;
  }

  async decide<const Q extends DecideQuestions>(
    request: DecideRequest<Q>,
  ): Promise<DecideResponse<Q>> {
    const parsed = parseDecideRequest(request);
    return this.unwrapResult(
      await this.executeParsed(
        { function: "decide", request: parsed },
        getWorkspaceClient,
      ),
      "decide",
    ) as DecideResponse<Q>;
  }

  /**
   * Runs a task definition (registered or not) with the given input, in the
   * caller's context: the service principal by default, the user under
   * `asUser(req)`. The task's `auth` applies only to routes and tools.
   */
  async run<const T extends AiFunctionTask>(
    task: T,
    input: AiFunctionTaskInput<T>,
    options: { signal?: AbortSignal } = {},
  ): Promise<AiFunctionTaskResult<T>> {
    let prepared: PreparedTask;
    try {
      prepared = prepareTask(task);
    } catch (error) {
      if (error instanceof TaskDefinitionError) {
        const fn = (task as { function?: unknown } | null | undefined)
          ?.function;
        throw new AiFunctionsRequestError(error.message, {
          statusCode: 400,
          functionName: fn === "extract" || fn === "decide" ? fn : "classify",
        });
      }
      throw error;
    }
    const parsed = this.withInput(
      prepared,
      parseTaskInput(prepared.function, input),
    );
    return this.unwrapResult(
      await this.executeParsed(parsed, getWorkspaceClient, {
        signal: options.signal,
      }),
      prepared.function,
    ) as AiFunctionTaskResult<T>;
  }

  injectRoutes(router: IAppRouter) {
    this.route(router, {
      name: "invoke",
      method: "post",
      path: "/:task/invoke",
      handler: async (req: express.Request, res: express.Response) => {
        const name = req.params.task;
        const stored = this.tasks.get(name);
        if (!stored) {
          res.status(404).json({
            error: `No task configured with name "${name}"`,
            plugin: this.name,
          });
          return;
        }
        // Spec §5.1 order: resolve the task, parse the body, then pick the identity.
        let input: ReturnType<typeof parseTaskInput>;
        try {
          input = parseTaskInput(stored.function, req.body);
        } catch (error) {
          this.sendValidationError(error, res);
          return;
        }
        const runner =
          stored.auth === "on-behalf-of-user" ? this._asUserScoped(req) : this;
        this.sendResult(res, await runner.invokeStored(stored, input));
      },
    });
  }

  clientConfig(): AiFunctionsClientConfig {
    const tasks: Record<string, { function: AiFunctionName }> = {};
    for (const [name, stored] of this.tasks) {
      tasks[name] = { function: stored.function };
    }
    return { tasks };
  }

  getAgentTools(): AgentToolDefinition[] {
    return toolsFromRegistry(this.tools);
  }

  async executeAgentTool(
    name: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!Object.hasOwn(this.tools, name)) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return executeFromRegistry(this.tools, name, args, signal);
  }

  toolkit(opts?: ToolkitOptions) {
    return buildToolkitEntries(this.name, this.tools, opts);
  }

  exports() {
    return {
      classify: this.classify.bind(this),
      extract: this.extract.bind(this),
      decide: this.decide.bind(this),
      run: this.run.bind(this),
    };
  }

  async shutdown(): Promise<void> {
    // No streams or persistent connections to clean up
  }

  private prepareConfiguredTask(name: string, task: unknown): PreparedTask {
    if (!TASK_NAME_PATTERN.test(name)) {
      throw new ConfigurationError(
        `aiFunctions task "${name}": name must match ${TASK_NAME_PATTERN.source}`,
      );
    }
    try {
      return prepareTask(task);
    } catch (error) {
      if (error instanceof TaskDefinitionError) {
        throw new ConfigurationError(
          `aiFunctions task "${name}": ${error.message}`,
        );
      }
      throw error;
    }
  }

  private defineTaskTool(stored: StoredTask): ToolEntry {
    const schema =
      stored.function === "decide"
        ? z.object({
            state: z
              .union([z.string(), z.record(z.string(), z.unknown())])
              .describe("The situation to judge"),
          })
        : z.object({
            content: z
              .string()
              .min(1)
              .describe(
                stored.function === "classify"
                  ? "Text to classify"
                  : "Text to extract fields from",
              ),
          });
    return defineTool({
      description: stored.description ?? this.generatedDescription(stored),
      schema,
      // requiresUserContext says whose identity the call uses. Core's executeTool
      // calls asUser(req) for every tool, so a user token is needed in
      // production either way (documented in the plugin docs).
      annotations: {
        effect: "read",
        requiresUserContext: stored.auth === "on-behalf-of-user",
      },
      execute: async (args, signal) =>
        this.unwrapResult(
          await this.invokeStored(
            stored,
            parseTaskInput(stored.function, args),
            {
              signal,
              // Tool errors land on the executeTool span; keep the upstream detail off it.
              includeDetail: false,
            },
          ),
          stored.function,
        ),
    });
  }

  private generatedDescription(stored: StoredTask): string {
    switch (stored.function) {
      case "classify": {
        const { labels } = stored.template;
        const names = Array.isArray(labels) ? [...labels] : Object.keys(labels);
        return `Classify text as one of: ${listUpTo20(names)}.`;
      }
      case "extract": {
        const { schema } = stored.template;
        const names = Array.isArray(schema) ? [...schema] : Object.keys(schema);
        return `Extract these fields from text: ${listUpTo20(names)}.`;
      }
      case "decide":
        return `Answer these questions about a situation: ${listUpTo20(Object.keys(stored.template.questions))}.`;
    }
  }

  /** Puts a validated input into a task's request template. */
  private withInput(
    task: PreparedTask,
    input: ReturnType<typeof parseTaskInput>,
  ): ParsedRequest {
    switch (task.function) {
      case "classify":
        return {
          function: "classify",
          request: {
            ...task.template,
            ...(input as Pick<ClassifyRequest, "content">),
          },
        };
      case "extract":
        return {
          function: "extract",
          request: {
            ...task.template,
            ...(input as Pick<ExtractRequest, "content">),
          },
        };
      case "decide":
        return {
          function: "decide",
          request: {
            ...task.template,
            ...(input as Pick<DecideRequest, "state">),
          },
        };
    }
  }

  /**
   * Runs a registered task with its configured identity (routes and tools).
   * The input must already be parsed with `parseTaskInput`. Service-principal
   * tasks always use the service client, even inside a user context (the
   * agent runtime calls tools through `asUser(req)`).
   */
  private async invokeStored(
    stored: StoredTask,
    input: ReturnType<typeof parseTaskInput>,
    options: { signal?: AbortSignal; includeDetail?: boolean } = {},
  ): Promise<ExecutionResult<unknown>> {
    const parsed = this.withInput(stored, input);
    const run = (auth: string, actorId?: string) =>
      this.executeParsed(parsed, getWorkspaceClient, {
        ...options,
        task: { name: stored.name, auth, actorId },
      });
    if (stored.auth === "on-behalf-of-user") return run(stored.auth);
    // A service-principal task never widens an on-behalf-of-user scope (an
    // on-behalf-of-user agent run, or runAgent with a caller): it runs as
    // that user. Elsewhere, including a mixed agent's legacy tool scope, it
    // leaves the caller scope and runs as the app.
    if (getCallerContext() && !isLegacyCallerScope()) {
      return run("on-behalf-of-user");
    }
    const actorId = getCallerContext() ? getCurrentActorId() : undefined;
    return runOutsideCallerScope(() => run(stored.auth, actorId));
  }

  /**
   * The single execution path. Callers differ only in `resolveClient`.
   *
   * The upstream 400 detail can quote request text. It's kept off
   * the `plugin.execute` span and the "Plugin execution failed" log: the
   * error thrown inside `execute()` carries only the generic message, and
   * the detail is added to the caller's result afterwards. Tools pass
   * `includeDetail: false`, because agent tool errors land on the
   * `executeTool` span.
   */
  private async executeParsed(
    parsed: ParsedRequest,
    resolveClient: () => WorkspaceClient,
    options: {
      signal?: AbortSignal;
      task?: { name: string; auth: string; actorId?: string };
      includeDetail?: boolean;
    } = {},
  ): Promise<ExecutionResult<unknown>> {
    let detail: string | undefined;
    const result = await this.execute(async (interceptorSignal) => {
      const client = this.resolveClient(resolveClient);
      const signal = combineSignals(interceptorSignal, options.signal);
      try {
        switch (parsed.function) {
          case "classify":
            return await this.connector.classify(
              client,
              parsed.request,
              signal,
            );
          case "extract":
            return await this.connector.extract(client, parsed.request, signal);
          case "decide":
            return await this.connector.decide(client, parsed.request, signal);
        }
      } catch (error) {
        // The connector reports an abort as a 504 timeout. When the caller's
        // own signal (run's `signal`, or an agent cancel) caused it, it's a
        // cancel. A real upstream failure keeps its own status.
        if (
          error instanceof AiFunctionsTransportError &&
          error.aborted &&
          options.signal?.aborted
        ) {
          throw new AiFunctionsRequestError(
            "AI Functions request was canceled",
            {
              statusCode: 499,
              functionName: parsed.function,
            },
          );
        }
        detail =
          error instanceof AiFunctionsTransportError ? error.detail : undefined;
        throw this.toRequestError(error, parsed.function);
      }
    }, this.executionSettings(options.task));
    if (
      !result.ok &&
      result.status === 400 &&
      detail &&
      (options.includeDetail ?? true)
    ) {
      return { ...result, message: `${result.message}: ${detail}` };
    }
    return result;
  }

  /**
   * Resolves the workspace client. Setup failures are rethrown as
   * non-retryable, because the retry interceptor retries unknown errors and
   * retryable AppKitErrors (for example InitializationError).
   */
  private resolveClient(resolve: () => WorkspaceClient): WorkspaceClient {
    try {
      return resolve();
    } catch (error) {
      if (error instanceof AppKitError && !error.isRetryable) throw error;
      const isDev = process.env.NODE_ENV !== "production";
      throw new ExecutionError(
        isDev && error instanceof Error ? error.message : "Server error",
        { cause: error instanceof Error ? error : undefined },
      );
    }
  }

  private sendValidationError(error: unknown, res: express.Response): void {
    if (error instanceof AiFunctionsRequestError && error.statusCode === 400) {
      res.status(400).json({ error: error.clientMessage, plugin: this.name });
      return;
    }
    throw error;
  }

  private sendResult<T>(
    res: express.Response,
    result: ExecutionResult<T>,
  ): void {
    if (!result.ok) {
      res.status(result.status).json({
        error: result.message,
        plugin: this.name,
      });
      return;
    }
    res.json(result.data);
  }

  private executionSettings(task?: {
    name: string;
    auth: string;
    actorId?: string;
  }): PluginExecutionSettings {
    const configured = this.config.timeout;
    const timeout =
      typeof configured === "number" &&
      Number.isFinite(configured) &&
      configured >= 1
        ? configured
        : aiFunctionsDefaults.timeout;
    const executionConfig: PluginExecuteConfig = {
      ...aiFunctionsDefaults,
      timeout,
      cache: { enabled: false },
      retry: { ...aiFunctionsDefaults.retry, ...this.config.retry },
      ...(task
        ? {
            telemetryInterceptor: {
              // ai.function.auth is the identity the task ran as. When a
              // service-principal task leaves a caller scope, the
              // appkit.execution.* attributes describe the app, so
              // ai.function.actor_id keeps the user who triggered it.
              attributes: {
                "ai.function.task": task.name,
                "ai.function.auth": task.auth,
                ...(task.actorId
                  ? { "ai.function.actor_id": task.actorId }
                  : {}),
              },
            },
          }
        : {}),
    };

    return {
      default: executionConfig,
      user: executionConfig,
    };
  }

  private unwrapResult<T>(
    result: ExecutionResult<T>,
    functionName: AiFunctionName,
  ): T {
    if (result.ok) return result.data;
    // An expired user token keeps AppKit's own IDENTITY_EXPIRED error.
    if (result.error) throw result.error;
    throw new AiFunctionsRequestError(result.message, {
      statusCode: result.status,
      functionName,
    });
  }

  private toRequestError(
    error: unknown,
    functionName: AiFunctionName,
  ): AiFunctionsRequestError {
    const statusCode =
      error &&
      typeof error === "object" &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 502;
    // Generic message only. executeParsed adds the 400 detail outside execute().
    const message =
      error instanceof AiFunctionsTransportError
        ? error.message
        : this.messageForStatus(statusCode);

    return new AiFunctionsRequestError(message, {
      statusCode,
      functionName,
      // A 401 keeps its source so AppKit can report an expired user token.
      // Other statuses don't: a 400 source can quote the request.
      ...(statusCode === 401 && error instanceof Error ? { cause: error } : {}),
    });
  }

  private messageForStatus(statusCode: number): string {
    switch (statusCode) {
      case 400:
        return "Invalid AI Functions request";
      case 401:
        return "AI Functions authentication required";
      case 403:
        return "Not authorized to call AI Functions";
      case 429:
        return "AI Functions rate limit exceeded";
      case 502:
        return "AI Functions request failed";
      case 504:
        return "AI Functions request timed out";
      default:
        return statusCode >= 500
          ? "AI Functions service unavailable"
          : "AI Functions request failed";
    }
  }
}

export const aiFunctions = toPlugin(AiFunctionsPlugin);
