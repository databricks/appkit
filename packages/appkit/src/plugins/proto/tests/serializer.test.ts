import { describe, expect, test, vi } from "vitest";
import { ProtoSerializer } from "../serializer";

vi.mock("@bufbuild/protobuf", () => ({
  toBinary: vi.fn((_s: any, msg: any) => new TextEncoder().encode(JSON.stringify(msg))),
  fromBinary: vi.fn((_s: any, data: Uint8Array) => JSON.parse(new TextDecoder().decode(data))),
  toJson: vi.fn((_s: any, msg: any) => msg),
  fromJson: vi.fn((_s: any, json: any) => json),
}));

describe("ProtoSerializer", () => {
  const schema = { typeName: "test.Message" } as any;
  const message = { name: "test", value: 42 };

  test("serialize produces Uint8Array", () => {
    const s = new ProtoSerializer();
    const result = s.serialize(schema, message as any);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBeGreaterThan(0);
  });

  test("round-trip preserves data", () => {
    const s = new ProtoSerializer();
    const bytes = s.serialize(schema, message as any);
    const recovered = s.deserialize(schema, bytes);
    expect(recovered).toEqual(message);
  });

  test("toJSON returns value", () => {
    const s = new ProtoSerializer();
    expect(s.toJSON(schema, message as any)).toEqual(message);
  });

  test("fromJSON returns value", () => {
    const s = new ProtoSerializer();
    expect(s.fromJSON(schema, message as any)).toEqual(message);
  });

  test("handles nested objects", () => {
    const s = new ProtoSerializer();
    const nested = {
      metadata: { entries: { k1: "v1" } },
      rows: [{ fields: { score: { case: "numberValue", value: 95 } } }],
    };
    const bytes = s.serialize(schema, nested as any);
    expect(s.deserialize(schema, bytes)).toEqual(nested);
  });

  test("deserialize throws on invalid data", () => {
    const s = new ProtoSerializer();
    expect(() => s.deserialize(schema, new Uint8Array([0xff, 0xfe]))).toThrow();
  });
});
