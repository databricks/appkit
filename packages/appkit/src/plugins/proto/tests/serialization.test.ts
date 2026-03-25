import { describe, expect, test, vi } from "vitest";
import { ProtoSerializer } from "../serialization";

// Mock @bufbuild/protobuf
vi.mock("@bufbuild/protobuf", () => {
  // Simple mock serialization: JSON encode/decode as Uint8Array
  return {
    toBinary: vi.fn((schema: any, message: any) => {
      const json = JSON.stringify(message);
      return new TextEncoder().encode(json);
    }),
    fromBinary: vi.fn((_schema: any, data: Uint8Array) => {
      const json = new TextDecoder().decode(data);
      return JSON.parse(json);
    }),
    toJson: vi.fn((_schema: any, message: any) => message),
    fromJson: vi.fn((_schema: any, json: any) => json),
  };
});

describe("ProtoSerializer", () => {
  const serializer = new ProtoSerializer();

  const mockSchema = {
    typeName: "appkit.v1.TestMessage",
  } as any;

  const mockMessage = {
    name: "test",
    value: 42,
    active: true,
  };

  test("serialize produces Uint8Array", () => {
    const result = serializer.serialize(mockSchema, mockMessage as any);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBeGreaterThan(0);
  });

  test("deserialize recovers original message", () => {
    const bytes = serializer.serialize(mockSchema, mockMessage as any);
    const result = serializer.deserialize(mockSchema, bytes);
    expect(result).toEqual(mockMessage);
  });

  test("serialize/deserialize round-trip preserves data", () => {
    const original = {
      jobRunId: "run-123",
      status: 3,
      rows: [
        { fields: { name: "Alice", score: 95 } },
        { fields: { name: "Bob", score: 82 } },
      ],
    };

    const bytes = serializer.serialize(mockSchema, original as any);
    const recovered = serializer.deserialize(mockSchema, bytes);
    expect(recovered).toEqual(original);
  });

  test("toJSON returns JSON representation", () => {
    const result = serializer.toJSON(mockSchema, mockMessage as any);
    expect(result).toEqual(mockMessage);
  });

  test("fromJSON parses JSON back to message", () => {
    const result = serializer.fromJSON(mockSchema, mockMessage as any);
    expect(result).toEqual(mockMessage);
  });

  test("serialize handles empty message", () => {
    const empty = {};
    const bytes = serializer.serialize(mockSchema, empty as any);
    const recovered = serializer.deserialize(mockSchema, bytes);
    expect(recovered).toEqual(empty);
  });

  test("serialize handles message with nested objects", () => {
    const nested = {
      metadata: { entries: { key1: "val1", key2: "val2" } },
      rows: [
        {
          fields: {
            score: { case: "numberValue", value: 95.5 },
            name: { case: "stringValue", value: "Alice" },
          },
        },
      ],
    };

    const bytes = serializer.serialize(mockSchema, nested as any);
    const recovered = serializer.deserialize(mockSchema, bytes);
    expect(recovered).toEqual(nested);
  });

  test("deserialize throws on invalid binary data", () => {
    const invalidData = new Uint8Array([0xff, 0xfe, 0xfd]);
    expect(() => serializer.deserialize(mockSchema, invalidData)).toThrow();
  });
});
