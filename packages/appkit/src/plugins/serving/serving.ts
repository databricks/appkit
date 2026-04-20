import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type express from "express";
import type { IAppRouter } from "shared";
import * as servingConnector from "../../connectors/serving/client";
import { getWorkspaceClient } from "../../context";
import { createLogger } from "../../logging";
import { type ExecutionResult, Plugin, toPlugin } from "../../plugin";
import type { PluginManifest, ResourceRequirement } from "../../registry";
import { ResourceType } from "../../registry";
import { servingInvokeDefaults } from "./defaults";
import manifest from "./manifest.json";
import { filterRequestBody, loadEndpointSchemas } from "./schema-filter";
import type {
  EndpointConfig,
  IServingConfig,
  ServingEndpointMethods,
  ServingFactory,
} from "./types";

const logger = createLogger("serving");

class EndpointNotFoundError extends Error {
  constructor(alias: string) {
    super(`Unknown endpoint alias: ${alias}`);
  }
}

class EndpointNotConfiguredError extends Error {
  constructor(alias: string, envVar: string) {
    super(
      `Endpoint '${alias}' is not configured: env var '${envVar}' is not set`,
    );
  }
}

interface ResolvedEndpoint {
  name: string;
}

/**
 * TODO(serving-validation-follow-up): migrate request-body validation to the
 * framework's `RouteConfig.body` mechanism (Standard Schema) once a per-request
 * schema resolution story lands — see GitHub issue <TODO: open and link>.
 *
 * The other AppKit plugins (analytics, genie, vector-search, files/mkdir) all
 * declare their request-body schemas statically on `RouteConfig.body` and rely
 * on the framework to validate incoming `req.body` against a Standard Schema
 * before the handler runs.
 *
 * The serving plugin is the exception: its body shape is NOT static. Each
 * configured alias proxies to a different model-serving endpoint, and every
 * endpoint has its own input schema (inferred and cached on disk at
 * `.databricks/appkit/.appkit-serving-types-cache.json`). The body therefore
 * has to be resolved and filtered per-request via `filterRequestBody()` in
 * `_handleInvoke` / `_handleStream` / `invoke`, keyed off the `:alias` route
 * param.
 *
 * Fitting this into `RouteConfig.body` needs its own design conversation —
 * most likely a function-form `body: (req) => schema` that resolves the
 * Standard Schema per-request based on the alias and the loaded allowlists.
 * Until that lands, serving validation intentionally stays inside
 * `filterRequestBody()` rather than the framework pipeline.
 */
export class ServingPlugin extends Plugin {
  static manifest = manifest as PluginManifest<"serving">;

  protected static description =
    "Authenticated proxy to Databricks Model Serving endpoints";
  protected declare config: IServingConfig;

  private readonly endpoints: Record<string, EndpointConfig>;
  private readonly isNamedMode: boolean;
  private schemaAllowlists = new Map<string, Set<string>>();

  constructor(config: IServingConfig) {
    super(config);
    this.config = config;

    if (config.endpoints) {
      this.endpoints = config.endpoints;
      this.isNamedMode = true;
    } else {
      this.endpoints = {
        default: { env: "DATABRICKS_SERVING_ENDPOINT_NAME" },
      };
      this.isNamedMode = false;
    }
  }

  async setup(): Promise<void> {
    const cacheFile = path.join(
      process.cwd(),
      "node_modules",
      ".databricks",
      "appkit",
      ".appkit-serving-types-cache.json",
    );
    this.schemaAllowlists = await loadEndpointSchemas(cacheFile);
    if (this.schemaAllowlists.size > 0) {
      logger.debug(
        "Loaded schema allowlists for %d endpoint(s)",
        this.schemaAllowlists.size,
      );
    }
  }

  static getResourceRequirements(
    config: IServingConfig,
  ): ResourceRequirement[] {
    const endpoints = config.endpoints ?? {
      default: { env: "DATABRICKS_SERVING_ENDPOINT_NAME" },
    };

    return Object.entries(endpoints).map(([alias, endpointConfig]) => ({
      type: ResourceType.SERVING_ENDPOINT,
      alias: `serving-${alias}`,
      resourceKey: `serving-${alias}`,
      description: `Model Serving endpoint for "${alias}" inference`,
      permission: "CAN_QUERY" as const,
      fields: {
        name: {
          env: endpointConfig.env,
          description: `Serving endpoint name for "${alias}"`,
        },
      },
      required: true,
    }));
  }

  private resolveAndFilter(
    alias: string,
    body: Record<string, unknown>,
  ): { endpoint: ResolvedEndpoint; filteredBody: Record<string, unknown> } {
    const config = this.endpoints[alias];
    if (!config) {
      throw new EndpointNotFoundError(alias);
    }

    const name = process.env[config.env];
    if (!name) {
      throw new EndpointNotConfiguredError(alias, config.env);
    }

    const endpoint: ResolvedEndpoint = { name };
    const filteredBody = filterRequestBody(
      body,
      this.schemaAllowlists,
      alias,
      this.config.filterMode,
    );
    return { endpoint, filteredBody };
  }

  // All serving routes use OBO (On-Behalf-Of) by default, consistent with the
  // Genie and Files plugins. This ensures per-user CAN_QUERY permissions are enforced.
  injectRoutes(router: IAppRouter) {
    if (this.isNamedMode) {
      this.route(router, {
        name: "invoke",
        method: "post",
        path: "/:alias/invoke",
        handler: async (req: express.Request, res: express.Response) => {
          await this.asUser(req)._handleInvoke(req, res);
        },
      });

      this.route(router, {
        name: "stream",
        method: "post",
        path: "/:alias/stream",
        handler: async (req: express.Request, res: express.Response) => {
          await this.asUser(req)._handleStream(req, res);
        },
      });
    } else {
      // Unnamed mode: register both /invoke and /:alias/invoke patterns.
      // The type generator creates a "default" alias, so clients may use either URL.
      const invokeHandler = async (
        req: express.Request,
        res: express.Response,
      ) => {
        req.params.alias ??= "default";
        await this.asUser(req)._handleInvoke(req, res);
      };
      const streamHandler = async (
        req: express.Request,
        res: express.Response,
      ) => {
        req.params.alias ??= "default";
        await this.asUser(req)._handleStream(req, res);
      };

      this.route(router, {
        name: "invoke",
        method: "post",
        path: "/invoke",
        handler: invokeHandler,
      });
      this.route(router, {
        name: "invoke-named",
        method: "post",
        path: "/:alias/invoke",
        handler: invokeHandler,
      });
      this.route(router, {
        name: "stream",
        method: "post",
        path: "/stream",
        handler: streamHandler,
      });
      this.route(router, {
        name: "stream-named",
        method: "post",
        path: "/:alias/stream",
        handler: streamHandler,
      });
    }
  }

  async _handleInvoke(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const { alias } = req.params;
    const rawBody = req.body as Record<string, unknown>;

    try {
      const result = await this.invoke(alias, rawBody);
      if (!result.ok) {
        res.status(result.status).json({ error: result.message });
        return;
      }
      res.json(result.data);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invocation failed";
      if (err instanceof EndpointNotFoundError) {
        res.status(404).json({ error: message });
      } else if (
        err instanceof EndpointNotConfiguredError ||
        message.startsWith("Unknown request parameters:")
      ) {
        res.status(400).json({ error: message });
      } else {
        res.status(502).json({ error: message });
      }
    }
  }

  async _handleStream(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const { alias } = req.params;
    const rawBody = req.body as Record<string, unknown>;

    let endpoint: ResolvedEndpoint;
    let filteredBody: Record<string, unknown>;
    try {
      ({ endpoint, filteredBody } = this.resolveAndFilter(alias, rawBody));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid request";
      const status = err instanceof EndpointNotFoundError ? 404 : 400;
      res.status(status).json({ error: message });
      return;
    }

    const timeout = this.config.timeout ?? 120_000;
    const workspaceClient = getWorkspaceClient();

    // Pipe raw SSE bytes from the upstream endpoint directly to the client.
    // No parsing/re-serialization — the upstream response is already valid SSE.
    let rawStream: ReadableStream<Uint8Array>;
    try {
      rawStream = await servingConnector.stream(
        workspaceClient,
        endpoint.name,
        filteredBody,
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Streaming request failed";
      res.status(502).json({ error: message });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Content-Encoding", "none");
    res.flushHeaders();

    const nodeStream = Readable.fromWeb(
      rawStream as import("stream/web").ReadableStream,
    );
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), timeout);

    req.on("close", () => abortController.abort());

    try {
      await pipeline(nodeStream, res, { signal: abortController.signal });
    } catch (err) {
      // AbortError is expected on client disconnect or timeout
      if (err instanceof Error && err.name !== "AbortError") {
        logger.warn("Stream pipe error: %s", err.message);
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async invoke(
    alias: string,
    body: Record<string, unknown>,
  ): Promise<ExecutionResult<unknown>> {
    const { endpoint, filteredBody } = this.resolveAndFilter(alias, body);
    const workspaceClient = getWorkspaceClient();
    const timeout = this.config.timeout ?? 120_000;

    return this.execute(
      () =>
        servingConnector.invoke(workspaceClient, endpoint.name, filteredBody),
      {
        default: {
          ...servingInvokeDefaults,
          timeout,
        },
      },
    );
  }

  clientConfig(): Record<string, unknown> {
    return {
      isNamedMode: this.isNamedMode,
      aliases: Object.keys(this.endpoints),
    };
  }

  async shutdown(): Promise<void> {
    this.streamManager.abortAll();
  }

  protected createEndpointAPI(alias: string): ServingEndpointMethods {
    return {
      invoke: (body: Record<string, unknown>) => this.invoke(alias, body),
    };
  }

  exports(): ServingFactory {
    const resolveEndpoint = (alias?: string) => {
      const resolved = alias ?? "default";
      const spApi = this.createEndpointAPI(resolved);
      return {
        ...spApi,
        asUser: (req: express.Request) => {
          const userPlugin = this.asUser(req) as ServingPlugin;
          return userPlugin.createEndpointAPI(resolved);
        },
      };
    };
    return resolveEndpoint as ServingFactory;
  }
}

/**
 * @internal
 */
export const serving = toPlugin(ServingPlugin);
