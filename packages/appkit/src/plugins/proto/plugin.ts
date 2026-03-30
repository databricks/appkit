import type { DescMessage, JsonValue, MessageShape } from "@bufbuild/protobuf";
import { create } from "@bufbuild/protobuf";
import type express from "express";
import type { IAppRouter } from "shared";
import { Plugin, toPlugin } from "../../plugin";
import type { PluginManifest } from "../../registry";
import manifest from "./manifest.json";
import { ProtoSerializer } from "./serializer";
import type { IProtoConfig } from "./types";

/**
 * Proto plugin for AppKit.
 *
 * Typed data contracts for AppKit applications.
 *
 * Provides protobuf-based serialization so plugins, routes, and
 * jobs share a single schema definition.
 */
export class ProtoPlugin extends Plugin<IProtoConfig> {
  static manifest = manifest as PluginManifest<"proto">;
  protected declare config: IProtoConfig;
  private serializer: ProtoSerializer;

  constructor(config: IProtoConfig) {
    super(config);
    this.config = config;
    this.serializer = new ProtoSerializer();
  }

  /** Create a new proto message with optional initial values. */
  create<T extends DescMessage>(schema: T, init?: Partial<MessageShape<T>>): MessageShape<T> {
    return create(schema, init as MessageShape<T>);
  }

  /** Serialize a protobuf message to binary. */
  serialize<T extends DescMessage>(schema: T, message: MessageShape<T>): Uint8Array {
    return this.serializer.serialize(schema, message);
  }

  /** Deserialize a protobuf message from binary. */
  deserialize<T extends DescMessage>(schema: T, data: Uint8Array): MessageShape<T> {
    return this.serializer.deserialize(schema, data);
  }

  /** Convert a protobuf message to JSON (snake_case field names). */
  toJSON<T extends DescMessage>(schema: T, message: MessageShape<T>): JsonValue {
    return this.serializer.toJSON(schema, message);
  }

  /** Parse a protobuf message from JSON. */
  fromJSON<T extends DescMessage>(schema: T, json: JsonValue): MessageShape<T> {
    return this.serializer.fromJSON(schema, json);
  }

  injectRoutes(router: IAppRouter): void {
    this.route(router, {
      name: "health",
      method: "get",
      path: "/health",
      handler: async (_req: express.Request, res: express.Response) => {
        res.json({ status: "ok" });
      },
    });
  }

  async shutdown(): Promise<void> {
    this.streamManager.abortAll();
  }

  exports() {
    return {
      create: this.create.bind(this),
      serialize: this.serialize.bind(this),
      deserialize: this.deserialize.bind(this),
      toJSON: this.toJSON.bind(this),
      fromJSON: this.fromJSON.bind(this),
    };
  }
}

/** @internal */
export const proto = toPlugin(ProtoPlugin);
