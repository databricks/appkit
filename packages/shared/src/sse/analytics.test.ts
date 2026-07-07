import { describe, expect, test } from "vitest";
import { AnalyticsSseMessage, makeResultMessage } from "./analytics";

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

  test("rejects a retired arrow message — ARROW_STREAM no longer uses SSE", () => {
    // Arrow bytes now stream on the query response body, not the SSE channel,
    // so there is no `arrow` message type to parse.
    expect(() =>
      AnalyticsSseMessage.parse({ type: "arrow", statement_id: "stmt-1" }),
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

describe("typed builder", () => {
  test("makeResultMessage roundtrips through the schema", () => {
    const msg = makeResultMessage([{ id: 1 }], { statement_id: "s-1" });
    expect(() => AnalyticsSseMessage.parse(msg)).not.toThrow();
  });
});
