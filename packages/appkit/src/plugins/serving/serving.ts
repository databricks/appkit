import { randomUUID } from "node:crypto";
import path from "node:path";
import type express from "express";
import type { IAppRouter, StreamExecutionSettings } from "shared";
import * as servingConnector from "../../connectors/serving/client";
import { getWorkspaceClient } from "../../context";
import { createLogger } from "../../logging";
import { Plugin, toPlugin } from "../../plugin";
import type { PluginManifest, ResourceRequirement } from "../../registry";
import { ResourceType } from "../../registry";
import { servingInvokeDefaults, servingStreamDefaults } from "./defaults";
import manifest from "./manifest.json";
import { filterRequestBody, loadEndpointSchemas } from "./schema-filter";
import type { EndpointConfig, IServingConfig } from "./types";

const logger = createLogger("serving");

interface ResolvedEndpoint {
  name: string;
  servedModel?: string;
}

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
        default: { env: "DATABRICKS_SERVING_ENDPOINT" },
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
      default: { env: "DATABRICKS_SERVING_ENDPOINT" },
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

  private resolveEndpoint(alias: string): ResolvedEndpoint | null {
    const config = this.endpoints[alias];
    if (!config) return null;

    const name = process.env[config.env];
    if (!name) {
      logger.warn(
        "Endpoint alias '%s' configured but env var '%s' is not set",
        alias,
        config.env,
      );
      return null;
    }

    return { name, servedModel: config.servedModel };
  }

  private resolveAndFilter(
    alias: string,
    body: Record<string, unknown>,
  ): { endpoint: ResolvedEndpoint; filteredBody: Record<string, unknown> } {
    const config = this.endpoints[alias];
    if (!config) {
      throw new Error(`Unknown endpoint alias: ${alias}`);
    }

    const name = process.env[config.env];
    if (!name) {
      throw new Error(
        `Endpoint '${alias}' is not configured: env var '${config.env}' is not set`,
      );
    }

    const endpoint: ResolvedEndpoint = {
      name,
      servedModel: config.servedModel,
    };
    const filteredBody = filterRequestBody(body, this.schemaAllowlists, alias);
    return { endpoint, filteredBody };
  }

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
      this.route(router, {
        name: "invoke",
        method: "post",
        path: "/invoke",
        handler: async (req: express.Request, res: express.Response) => {
          req.params.alias = "default";
          await this.asUser(req)._handleInvoke(req, res);
        },
      });

      this.route(router, {
        name: "stream",
        method: "post",
        path: "/stream",
        handler: async (req: express.Request, res: express.Response) => {
          req.params.alias = "default";
          await this.asUser(req)._handleStream(req, res);
        },
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
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invocation failed";
      if (message.startsWith("Unknown endpoint alias:")) {
        res.status(404).json({ error: message });
      } else if (message.includes("is not configured:")) {
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
      const status = message.startsWith("Unknown endpoint alias:") ? 404 : 400;
      res.status(status).json({ error: message });
      return;
    }

    const timeout = this.config.timeout ?? 120_000;
    const requestId =
      (typeof req.query.requestId === "string" && req.query.requestId) ||
      randomUUID();

    const streamSettings: StreamExecutionSettings = {
      ...servingStreamDefaults,
      default: {
        ...servingStreamDefaults.default,
        timeout,
      },
      stream: {
        ...servingStreamDefaults.stream,
        streamId: requestId,
      },
    };

    const workspaceClient = getWorkspaceClient();

    await this.executeStream(
      res,
      () =>
        servingConnector.stream(workspaceClient, endpoint.name, filteredBody, {
          servedModel: endpoint.servedModel,
        }),
      streamSettings,
    );
  }

  async invoke(alias: string, body: Record<string, unknown>): Promise<unknown> {
    const { endpoint, filteredBody } = this.resolveAndFilter(alias, body);
    const workspaceClient = getWorkspaceClient();
    const timeout = this.config.timeout ?? 120_000;

    return this.execute(
      () =>
        servingConnector.invoke(workspaceClient, endpoint.name, filteredBody, {
          servedModel: endpoint.servedModel,
        }),
      {
        default: {
          ...servingInvokeDefaults,
          timeout,
        },
      },
    );
  }

  async *stream(
    alias: string,
    body: Record<string, unknown>,
  ): AsyncGenerator<unknown> {
    const { endpoint, filteredBody } = this.resolveAndFilter(alias, body);
    const workspaceClient = getWorkspaceClient();

    yield* servingConnector.stream(
      workspaceClient,
      endpoint.name,
      filteredBody,
      { servedModel: endpoint.servedModel },
    );
  }

  async shutdown(): Promise<void> {
    this.streamManager.abortAll();
  }

  exports() {
    return (alias?: string) => ({
      invoke: (body: Record<string, unknown>) =>
        this.invoke(alias ?? "default", body),
      stream: (body: Record<string, unknown>) =>
        this.stream(alias ?? "default", body),
    });
  }
}

/**
 * @internal
 */
export const serving = toPlugin(ServingPlugin);
