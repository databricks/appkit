import {
  type DescMessage,
  type MessageShape,
  fromBinary,
  fromJson,
  toBinary,
  toJson,
} from "@bufbuild/protobuf";
import type { JsonValue } from "@bufbuild/protobuf";

/**
 * Protobuf serializer for typed data contracts.
 *
 * Handles binary and JSON serialization/deserialization of proto messages.
 * For file I/O (UC Volumes), use the Files plugin.
 */
export class ProtoSerializer {
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

  /** Convert a protobuf message to JSON (uses proto field names — snake_case). */
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
}
