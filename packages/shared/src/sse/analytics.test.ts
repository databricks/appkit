import { describe, expect, test } from "vitest";
import {
  AnalyticsSseMessage,
  makeArrowInlineMessage,
  makeArrowMessage,
  makeResultMessage,
} from "./analytics";

describe("AnalyticsSseMessage schema", () => {
  test("accepts a result message with rows", () => {
    const parsed = AnalyticsSseMessage.parse({
      type: "result",
      data: [{ id: 1, name: "alice" }],
    });
    expect(parsed.type).toBe("result");
  });

  test("accepts a result message with no data (empty result)", () => {
    expect(() => AnalyticsSseMessage.parse({ type: "result" })).not.toThrow();
  });

  test("accepts an arrow message with statement_id", () => {
    const parsed = AnalyticsSseMessage.parse({
      type: "arrow",
      statement_id: "stmt-1",
    });
    expect(parsed.type).toBe("arrow");
  });

  test("rejects an arrow message with empty statement_id", () => {
    expect(() =>
      AnalyticsSseMessage.parse({ type: "arrow", statement_id: "" }),
    ).toThrow();
  });

  test("rejects an arrow message with no statement_id", () => {
    expect(() => AnalyticsSseMessage.parse({ type: "arrow" })).toThrow();
  });

  test("accepts an arrow_inline message with non-empty attachment", () => {
    const parsed = AnalyticsSseMessage.parse({
      type: "arrow_inline",
      attachment: "AQID",
    });
    expect(parsed.type).toBe("arrow_inline");
  });

  test("rejects an arrow_inline message with empty attachment", () => {
    expect(() =>
      AnalyticsSseMessage.parse({ type: "arrow_inline", attachment: "" }),
    ).toThrow();
  });

  test("rejects an arrow_inline message with non-string attachment", () => {
    expect(() =>
      AnalyticsSseMessage.parse({ type: "arrow_inline", attachment: 123 }),
    ).toThrow();
  });

  test("rejects an unknown type", () => {
    expect(() =>
      AnalyticsSseMessage.parse({ type: "unknown_kind", foo: "bar" }),
    ).toThrow();
  });

  test("safeParse returns success: false for malformed payloads", () => {
    const r = AnalyticsSseMessage.safeParse({ type: "arrow_inline" });
    expect(r.success).toBe(false);
  });
});

describe("typed builders", () => {
  test("makeResultMessage roundtrips through the schema", () => {
    const msg = makeResultMessage([{ id: 1 }], { statement_id: "s-1" });
    expect(() => AnalyticsSseMessage.parse(msg)).not.toThrow();
  });

  test("makeArrowMessage roundtrips through the schema", () => {
    const msg = makeArrowMessage("stmt-2");
    expect(() => AnalyticsSseMessage.parse(msg)).not.toThrow();
  });

  test("makeArrowInlineMessage roundtrips through the schema", () => {
    const msg = makeArrowInlineMessage("AQID");
    expect(() => AnalyticsSseMessage.parse(msg)).not.toThrow();
  });
});
