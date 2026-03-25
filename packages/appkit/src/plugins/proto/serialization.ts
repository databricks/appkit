import {
  type DescMessage,
  type MessageShape,
  fromBinary,
  fromJson,
  toBinary,
  toJson,
} from "@bufbuild/protobuf";
import type { JsonValue } from "@bufbuild/protobuf";
import { getWorkspaceClient } from "../../context";
import { createLogger } from "../../logging/logger";

const logger = createLogger("proto:serialization");

/**
 * Proto serialization helpers and UC Volume I/O.
 *
 * Wraps @bufbuild/protobuf's binary and JSON serialization with
 * convenience methods for reading/writing proto-encoded files
 * to Databricks Unity Catalog Volumes.
 */
export class ProtoSerializer {
  /**
   * Serialize a protobuf message to binary format.
   */
  serialize<T extends DescMessage>(
    schema: T,
    message: MessageShape<T>,
  ): Uint8Array {
    return toBinary(schema, message);
  }

  /**
   * Deserialize a protobuf message from binary format.
   */
  deserialize<T extends DescMessage>(
    schema: T,
    data: Uint8Array,
  ): MessageShape<T> {
    return fromBinary(schema, data);
  }

  /**
   * Convert a protobuf message to JSON-compatible value.
   */
  toJSON<T extends DescMessage>(
    schema: T,
    message: MessageShape<T>,
  ): JsonValue {
    return toJson(schema, message);
  }

  /**
   * Parse a protobuf message from a JSON value.
   */
  fromJSON<T extends DescMessage>(
    schema: T,
    json: JsonValue,
  ): MessageShape<T> {
    return fromJson(schema, json);
  }

  /**
   * Write a protobuf message as binary to a Databricks UC Volume path.
   *
   * Uses the Databricks SDK Files API to upload the serialized bytes.
   *
   * @param schema - The protobuf message descriptor
   * @param message - The message instance to serialize
   * @param volumePath - Full UC Volume path (e.g. /Volumes/catalog/schema/volume/file.pb)
   */
  async writeToVolume<T extends DescMessage>(
    schema: T,
    message: MessageShape<T>,
    volumePath: string,
  ): Promise<void> {
    const bytes = this.serialize(schema, message);
    const client = getWorkspaceClient();

    logger.debug(
      "Writing proto to volume: path=%s size=%d bytes",
      volumePath,
      bytes.byteLength,
    );

    const readableStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });

    await client.files.upload(volumePath, readableStream, { overwrite: true });

    logger.debug("Proto written to volume: path=%s", volumePath);
  }

  /**
   * Read and deserialize a protobuf message from a Databricks UC Volume path.
   *
   * @param schema - The protobuf message descriptor to deserialize into
   * @param volumePath - Full UC Volume path (e.g. /Volumes/catalog/schema/volume/file.pb)
   * @returns The deserialized protobuf message
   */
  async readFromVolume<T extends DescMessage>(
    schema: T,
    volumePath: string,
  ): Promise<MessageShape<T>> {
    const client = getWorkspaceClient();

    logger.debug("Reading proto from volume: path=%s", volumePath);

    const response = await client.files.download(volumePath);
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

    logger.debug(
      "Proto read from volume: path=%s size=%d bytes",
      volumePath,
      data.byteLength,
    );

    return this.deserialize(schema, data);
  }
}
