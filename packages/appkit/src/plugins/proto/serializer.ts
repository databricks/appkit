import {
  type DescMessage,
  type MessageShape,
  fromBinary,
  fromJson,
  toBinary,
  toJson,
} from "@bufbuild/protobuf";
import type { JsonValue } from "@bufbuild/protobuf";
import { FilesConnector } from "../../connectors/files";
import { getWorkspaceClient } from "../../context";
import { createLogger } from "../../logging/logger";

const logger = createLogger("proto");

/**
 * Protobuf serializer with typed UC Volume I/O.
 *
 * Uses FilesConnector (same as files plugin) for volume operations,
 * which provides the SDK upload bug workaround, path validation,
 * and per-operation telemetry tracing.
 */
export class ProtoSerializer {
  private connector: FilesConnector;

  constructor(defaultVolume?: string) {
    this.connector = new FilesConnector({
      defaultVolume,
      telemetry: true,
    });
  }

  /** Serialize a protobuf message to binary. */
  serialize<T extends DescMessage>(
    schema: T,
    message: MessageShape<T>,
  ): Uint8Array {
    return toBinary(schema, message);
  }

  /** Deserialize a protobuf message from binary. */
  deserialize<T extends DescMessage>(
    schema: T,
    data: Uint8Array,
  ): MessageShape<T> {
    return fromBinary(schema, data);
  }

  /** Convert a protobuf message to JSON. */
  toJSON<T extends DescMessage>(
    schema: T,
    message: MessageShape<T>,
  ): JsonValue {
    return toJson(schema, message);
  }

  /** Parse a protobuf message from JSON. */
  fromJSON<T extends DescMessage>(
    schema: T,
    json: JsonValue,
  ): MessageShape<T> {
    return fromJson(schema, json);
  }

  /**
   * Write a protobuf message to a UC Volume path.
   *
   * Uses FilesConnector which works around SDK upload bugs
   * (silently dropped body) by calling REST API directly.
   */
  async writeToVolume<T extends DescMessage>(
    schema: T,
    message: MessageShape<T>,
    path: string,
  ): Promise<void> {
    const bytes = this.serialize(schema, message);

    logger.debug("Writing proto: path=%s size=%d bytes", path, bytes.byteLength);

    await this.connector.upload(
      getWorkspaceClient(),
      path,
      Buffer.from(bytes),
      { overwrite: true },
    );
  }

  /**
   * Read and deserialize a protobuf message from a UC Volume path.
   */
  async readFromVolume<T extends DescMessage>(
    schema: T,
    path: string,
  ): Promise<MessageShape<T>> {
    logger.debug("Reading proto: path=%s", path);

    const response = await this.connector.download(getWorkspaceClient(), path);
    const chunks: Uint8Array[] = [];

    if (response.contents) {
      const reader = response.contents.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    }

    const totalLength = chunks.reduce((sum, c) => sum + c.byteLength, 0);
    const data = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return this.deserialize(schema, data);
  }

  /**
   * Check if a proto file exists on a UC Volume.
   */
  async exists(path: string): Promise<boolean> {
    return this.connector.exists(getWorkspaceClient(), path);
  }
}
