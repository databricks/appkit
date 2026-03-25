import type { DescMessage, JsonValue, MessageShape } from "@bufbuild/protobuf";
import type express from "express";
import type { IAppRouter, PluginExecutionSettings } from "shared";
import { createLogger } from "../../logging/logger";
import { Plugin, toPlugin } from "../../plugin";
import type { PluginManifest } from "../../registry";
import manifest from "./manifest.json";
import { ProtoSerializer } from "./serializer";
import type { IProtoConfig } from "./types";

const logger = createLogger("proto");

const volumeDefaults: PluginExecutionSettings = {
  default: {
    cache: { enabled: false },
    retry: { enabled: true, attempts: 3, initialDelay: 1000 },
    timeout: 60000,
  },
};

/**
 * Proto plugin for AppKit.
 *
 * Provides protobuf serialization and typed UC Volume I/O for
 * cross-language pipeline data contracts. Proto definitions in
 * proto/appkit/v1/ generate TypeScript types shared by frontend
 * and backend, and can generate Python types for Databricks Jobs.
 */
export class ProtoPlugin extends Plugin<IProtoConfig> {
  static manifest = manifest as PluginManifest<"proto">;
  protected declare config: IProtoConfig;
  private serializer: ProtoSerializer;

  constructor(config: IProtoConfig) {
    super(config);
    this.config = config;
    this.serializer = new ProtoSerializer(config.defaultVolume);
  }

  /** Serialize a protobuf message to binary. */
  serialize<T extends DescMessage>(schema: T, message: MessageShape<T>): Uint8Array {
    return this.serializer.serialize(schema, message);
  }

  /** Deserialize a protobuf message from binary. */
  deserialize<T extends DescMessage>(schema: T, data: Uint8Array): MessageShape<T> {
    return this.serializer.deserialize(schema, data);
  }

  /** Convert a protobuf message to JSON. */
  toJSON<T extends DescMessage>(schema: T, message: MessageShape<T>): JsonValue {
    return this.serializer.toJSON(schema, message);
  }

  /** Parse a protobuf message from JSON. */
  fromJSON<T extends DescMessage>(schema: T, json: JsonValue): MessageShape<T> {
    return this.serializer.fromJSON(schema, json);
  }

  /**
   * Write a protobuf message to a UC Volume.
   * Uses the interceptor chain for retry/timeout/telemetry.
   */
  async writeToVolume<T extends DescMessage>(
    schema: T,
    message: MessageShape<T>,
    path: string,
  ): Promise<void> {
    await this.execute(
      async () => this.serializer.writeToVolume(schema, message, path),
      volumeDefaults,
    );
  }

  /**
   * Read a protobuf message from a UC Volume.
   * Uses the interceptor chain for retry/timeout/telemetry.
   */
  async readFromVolume<T extends DescMessage>(
    schema: T,
    path: string,
  ): Promise<MessageShape<T> | undefined> {
    return this.execute(
      async () => this.serializer.readFromVolume(schema, path),
      volumeDefaults,
    );
  }

  /** Check if a proto file exists on a UC Volume. */
  async exists(path: string): Promise<boolean | undefined> {
    return this.execute(async () => this.serializer.exists(path), volumeDefaults);
  }

  injectRoutes(router: IAppRouter): void {
    this.route(router, {
      name: "health",
      method: "get",
      path: "/health",
      handler: async (_req: express.Request, res: express.Response) => {
        res.json({
          status: "ok",
          defaultVolume: this.config.defaultVolume ?? null,
        });
      },
    });
  }

  async shutdown(): Promise<void> {
    this.streamManager.abortAll();
  }

  exports() {
    return {
      serialize: this.serialize.bind(this),
      deserialize: this.deserialize.bind(this),
      toJSON: this.toJSON.bind(this),
      fromJSON: this.fromJSON.bind(this),
      writeToVolume: this.writeToVolume.bind(this),
      readFromVolume: this.readFromVolume.bind(this),
      exists: this.exists.bind(this),
    };
  }
}

/** @internal */
export const proto = toPlugin(ProtoPlugin);
