import { describe, expect, it } from "vitest";

import { citedText, extractValues, scoreLevel } from "../ai-functions-helpers";

const schema = {
  total: { type: "number" },
  status: { type: "enum", labels: ["paid", "unpaid"] },
  tags: { type: "array", items: { type: "string" } },
  items: {
    type: "array",
    items: { type: "object", properties: { qty: { type: "integer" } } },
  },
  contact: { type: "object", properties: { value: { type: "string" } } },
  legacy: { type: "string", enum: ["a", "b"] },
  missing: { type: "string" },
  missingList: { type: "array", items: { type: "string" } },
} as const;

describe("extractValues", () => {
  it("unwraps a nested response guided by the schema", () => {
    const values = extractValues(
      {
        response: {
          total: { value: 720, confidence_score: 1 },
          status: { value: "paid" },
          tags: [{ value: "urgent" }, { value: "fragile" }],
          items: [{ qty: { value: 3 } }],
          // A real property named "value" inside an object field:
          contact: { value: { value: "jane@acme.example" } },
          legacy: "a",
        } as never,
      },
      schema,
    );
    expect(values).toEqual({
      total: 720,
      status: "paid",
      tags: ["urgent", "fragile"],
      items: [{ qty: 3 }],
      contact: { value: "jane@acme.example" },
      legacy: "a",
      missing: null,
      missingList: [],
    });
  });

  it("unwraps names-only schemas", () => {
    expect(
      extractValues({ response: { name: { value: "Ada" } } as never }, [
        "name",
        "year",
      ] as const),
    ).toEqual({ name: "Ada", year: null });
  });

  it("returns undefined when response is absent", () => {
    expect(extractValues({ metadata: {} }, schema)).toBeUndefined();
  });
});

describe("citedText", () => {
  const content = "Invoice A-7781. Total due $720.00.";
  const metadata = {
    chunk_type: "span" as const,
    citations: [
      { id: 0, start: 0, stop: 15 },
      { id: 1, start: 16, stop: 34 },
    ],
  };

  it("slices span citations in id order", () => {
    expect(
      citedText(content, { value: 720, citation_ids: [1, 0] }, metadata),
    ).toEqual(["Total due $720.00.", "Invoice A-7781."]);
  });

  it("skips unknown ids", () => {
    expect(
      citedText(content, { value: 1, citation_ids: [9, 0] }, metadata),
    ).toEqual(["Invoice A-7781."]);
  });

  it("returns [] for bounding boxes, object content, or no citations", () => {
    expect(
      citedText(
        content,
        { value: 1, citation_ids: [0] },
        { chunk_type: "bbox", citations: [] },
      ),
    ).toEqual([]);
    expect(
      citedText({ body: content }, { value: 1, citation_ids: [0] }, metadata),
    ).toEqual([]);
    expect(citedText(content, { value: 1 }, metadata)).toEqual([]);
    expect(citedText(content, undefined, metadata)).toEqual([]);
  });
});

describe("scoreLevel", () => {
  const legend = { "0": "low", "1": "medium", "2": "high" };
  const answer = (score: number) => ({
    type: "score" as const,
    score,
    legend,
    probabilities: {},
    confidence: 0.9,
  });

  it("rounds the live example to the nearest level", () => {
    expect(scoreLevel(answer(1.5999999999999999))).toEqual({
      index: 2,
      level: "high",
    });
  });

  it("clamps to the legend range", () => {
    expect(scoreLevel(answer(-0.4))).toEqual({ index: 0, level: "low" });
    expect(scoreLevel(answer(7))).toEqual({ index: 2, level: "high" });
  });

  it("clamps to a legend that doesn't start at 0", () => {
    const answer1 = {
      type: "score" as const,
      score: 0.2,
      legend: { "1": "low", "2": "high" },
      probabilities: {},
      confidence: 1,
    };
    expect(scoreLevel(answer1)).toEqual({ index: 1, level: "low" });
  });
});
