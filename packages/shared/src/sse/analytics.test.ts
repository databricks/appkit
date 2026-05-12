import { describe, expect, test } from "vitest";
import {
  AnalyticsSseMessage,
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

  test("accepts an arrow message with warehouse statement_id", () => {
    const parsed = AnalyticsSseMessage.parse({
      type: "arrow",
      statement_id: "stmt-1",
    });
    expect(parsed.type).toBe("arrow");
  });

  test("accepts an arrow message with synthetic inline- id", () => {
    // Inline Arrow payloads are stashed server-side and surfaced through the
    // same `arrow` message variant — the `inline-` prefix tells the
    // /arrow-result handler to drain the stash instead of hitting the
    // warehouse. The schema must accept both id shapes transparently.
    const parsed = AnalyticsSseMessage.parse({
      type: "arrow",
      statement_id: "inline-abc-123",
    });
    expect(parsed.statement_id).toBe("inline-abc-123");
  });

  test("rejects an arrow message with empty statement_id", () => {
    expect(() =>
      AnalyticsSseMessage.parse({ type: "arrow", statement_id: "" }),
    ).toThrow();
  });

  test("rejects an arrow message with no statement_id", () => {
    expect(() => AnalyticsSseMessage.parse({ type: "arrow" })).toThrow();
  });

  test("rejects the retired arrow_inline message type", () => {
    // arrow_inline was the prior wire shape (base64 payload on the SSE
    // channel). The current protocol routes all Arrow payloads through
    // /arrow-result; the type must no longer parse.
    expect(() =>
      AnalyticsSseMessage.parse({ type: "arrow_inline", attachment: "AQID" }),
    ).toThrow();
  });

  test("rejects an unknown type", () => {
    expect(() =>
      AnalyticsSseMessage.parse({ type: "unknown_kind", foo: "bar" }),
    ).toThrow();
  });

  test("safeParse returns success: false for malformed payloads", () => {
    const r = AnalyticsSseMessage.safeParse({ type: "arrow" });
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

  test("makeArrowMessage accepts synthetic inline- ids", () => {
    const msg = makeArrowMessage("inline-some-uuid");
    expect(() => AnalyticsSseMessage.parse(msg)).not.toThrow();
  });
});
