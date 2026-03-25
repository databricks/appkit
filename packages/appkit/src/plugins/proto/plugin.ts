import type { ServiceType } from "@connectrpc/connect";
import type { DescMessage, JsonValue, MessageShape } from "@bufbuild/protobuf";
import type express from "express";
import type { IAppRouter, PluginExecutionSettings } from "shared";
import { createLogger } from "../../logging/logger";
import { Plugin, toPlugin } from "../../plugin";
import type { PluginManifest } from "../../registry";
import { DEFAULT_GRPC_PORT, grpcCallDefaults, volumeIODefaults } from "./defaults";
import { GrpcClientFactory } from "./grpc-client";
import { GrpcServer } from "./grpc-server";
import manifest from "./manifest.json";
import { ProtoSerializer } from "./serialization";
import type { GrpcClientOptions, IProtoConfig } from "./types";

const logger = createLogger("proto");

/**
 * Proto/gRPC plugin for AppKit.
 *
 * Provides:
 * - Protobuf binary and JSON serialization
 * - gRPC server (shared Express port or standalone HTTP/2)
 * - gRPC client factory for calling external services
 * - UC Volume I/O for pipeline data exchange with Databricks Jobs
 */
export class ProtoPlugin extends Plugin<IProtoConfig> {
  static manifest = manifest as PluginManifest<"proto">;

  protected declare config: IProtoConfig;

  private server: GrpcServer;
  private clientFactory: GrpcClientFactory;
  private serializer: ProtoSerializer;

  constructor(config: IProtoConfig) {
    super(config);
    this.config = config;

    this.server = new GrpcServer(config.serverOptions);
    this.clientFactory = new GrpcClientFactory(config.timeout);
    this.serializer = new ProtoSerializer();
  }

  async setup(): Promise<void> {
    // Register pre-configured services
    if (this.config.services?.length) {
      for (const { service, implementation } of this.config.services) {
        this.server.registerService(service, implementation);
      }
    }

    // Start standalone gRPC server if configured
    if (this.config.standalone) {
      const port = this.config.grpcPort ?? DEFAULT_GRPC_PORT;
      await this.server.start(port);
    }

    logger.info(
      "Proto plugin initialized (mode=%s, services=%d)",
      this.config.standalone ? "standalone" : "shared",
      this.server.getRegisteredServices().length,
    );
  }

  injectRoutes(router: IAppRouter): void {
    // In shared mode, mount Connect handlers on the Express router
    if (!this.config.standalone) {
      this.server.mountOnRouter(router);
    }

    // Health check endpoint
    this.route(router, {
      name: "health",
      method: "get",
      path: "/health",
      handler: async (_req: express.Request, res: express.Response) => {
        res.json({
          status: "ok",
          mode: this.config.standalone ? "standalone" : "shared",
          services: this.server.getRegisteredServices(),
        });
      },
    });

    // Service discovery endpoint
    this.route(router, {
      name: "services",
      method: "get",
      path: "/services",
      handler: async (_req: express.Request, res: express.Response) => {
        res.json({
          services: this.server.getRegisteredServices(),
        });
      },
    });
  }

  /**
   * Register a gRPC service at runtime.
   *
   * @param service - The Connect ServiceType descriptor
   * @param implementation - The service implementation
   */
  registerService<T extends ServiceType>(
    service: T,
    implementation: any,
  ): void {
    this.server.registerService(service, implementation);
  }

  /**
   * Create a typed gRPC client for calling an external service.
   *
   * @param service - The Connect ServiceType descriptor
   * @param target - Target URL
   * @param options - Client options (transport, timeout, headers)
   */
  createClient<T extends ServiceType>(
    service: T,
    target: string,
    options?: GrpcClientOptions,
  ) {
    return this.clientFactory.create(service, target, options);
  }

  /**
   * Serialize a protobuf message to binary (Uint8Array).
   */
  serialize<T extends DescMessage>(
    schema: T,
    message: MessageShape<T>,
  ): Uint8Array {
    return this.serializer.serialize(schema, message);
  }

  /**
   * Deserialize a protobuf message from binary.
   */
  deserialize<T extends DescMessage>(
    schema: T,
    data: Uint8Array,
  ): MessageShape<T> {
    return this.serializer.deserialize(schema, data);
  }

  /**
   * Convert a protobuf message to JSON.
   */
  toJSON<T extends DescMessage>(
    schema: T,
    message: MessageShape<T>,
  ): JsonValue {
    return this.serializer.toJSON(schema, message);
  }

  /**
   * Parse a protobuf message from JSON.
   */
  fromJSON<T extends DescMessage>(
    schema: T,
    json: JsonValue,
  ): MessageShape<T> {
    return this.serializer.fromJSON(schema, json);
  }

  /**
   * Write a protobuf message to a Databricks UC Volume.
   * Uses the interceptor chain for retry/timeout/telemetry.
   *
   * @param schema - Protobuf message descriptor
   * @param message - Message instance to write
   * @param volumePath - Full UC Volume path (e.g. /Volumes/catalog/schema/vol/file.pb)
   */
  async writeToVolume<T extends DescMessage>(
    schema: T,
    message: MessageShape<T>,
    volumePath: string,
  ): Promise<void> {
    const settings: PluginExecutionSettings = {
      default: volumeIODefaults,
    };

    await this.execute(
      async () => {
        await this.serializer.writeToVolume(schema, message, volumePath);
      },
      settings,
    );
  }

  /**
   * Read and deserialize a protobuf message from a Databricks UC Volume.
   * Uses the interceptor chain for retry/timeout/telemetry.
   *
   * @param schema - Protobuf message descriptor to deserialize into
   * @param volumePath - Full UC Volume path
   * @returns The deserialized message
   */
  async readFromVolume<T extends DescMessage>(
    schema: T,
    volumePath: string,
  ): Promise<MessageShape<T> | undefined> {
    const settings: PluginExecutionSettings = {
      default: volumeIODefaults,
    };

    return this.execute(
      async () => this.serializer.readFromVolume(schema, volumePath),
      settings,
    );
  }

  async shutdown(): Promise<void> {
    await this.server.stop();
    this.streamManager.abortAll();
    logger.info("Proto plugin shut down");
  }

  /**
   * Returns the public API for the proto plugin.
   * `asUser()` is automatically added by AppKit.
   */
  exports() {
    return {
      registerService: this.registerService.bind(this),
      createClient: this.createClient.bind(this),
      serialize: this.serialize.bind(this),
      deserialize: this.deserialize.bind(this),
      toJSON: this.toJSON.bind(this),
      fromJSON: this.fromJSON.bind(this),
      writeToVolume: this.writeToVolume.bind(this),
      readFromVolume: this.readFromVolume.bind(this),
    };
  }
}

/**
 * @internal
 */
export const proto = toPlugin(ProtoPlugin);
