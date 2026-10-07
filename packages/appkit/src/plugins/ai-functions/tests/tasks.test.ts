import { describe, expect, it } from "vitest";

import { AiFunctionsRequestError } from "../errors";
import { parseTaskInput } from "../schemas";
import { prepareTask, TASK_NAME_PATTERN, TaskDefinitionError } from "../tasks";

describe("prepareTask", () => {
  it("parses a classify task into a pinned request template", () => {
    expect(prepareTask({ function: "classify", labels: ["a", "b"] })).toEqual({
      function: "classify",
      auth: "service-principal",
      template: {
        content: "x",
        labels: ["a", "b"],
        options: { version: "2.1" },
      },
    });
  });

  it("keeps auth and description", () => {
    expect(
      prepareTask({
        function: "decide",
        questions: { q: { type: "noul", instructions: "Spam?" } },
        auth: "on-behalf-of-user",
        description: "Spam check",
      }),
    ).toMatchObject({
      function: "decide",
      auth: "on-behalf-of-user",
      description: "Spam check",
    });
  });

  it.each([
    [
      { function: "summarize" },
      'function must be "classify", "extract", or "decide"',
    ],
    [
      { function: "classify", labels: ["a", "b"], auth: "root" },
      'auth must be "service-principal" or "on-behalf-of-user"',
    ],
    [
      { function: "classify", labels: ["a", "b"], content: "x" },
      "a classify task must not include content",
    ],
    [
      { function: "extract", schema: ["a"], content: "x" },
      "an extract task must not include content",
    ],
    [
      {
        function: "decide",
        questions: { q: { type: "noul", instructions: "?" } },
        state: "x",
      },
      "a decide task must not include state",
    ],
    [
      { function: "classify", labels: ["a"] },
      "too_small: labels must have at least 2 items",
    ],
    [
      { function: "classify", labels: ["a", "b"], description: "" },
      "description must be a string of 1 to 1000 characters",
    ],
    [
      {
        function: "classify",
        labels: ["a", "b"],
        description: "d".repeat(1001),
      },
      "description must be a string of 1 to 1000 characters",
    ],
    [
      { function: "classify", labels: ["a"], description: "" },
      "too_small: labels must have at least 2 items",
    ],
    ["not an object", "task must be an object"],
  ])("rejects %j", (task, message) => {
    expect(() => prepareTask(task)).toThrow(new TaskDefinitionError(message));
  });

  it.each([
    [{ function: "classify", labels: ["secret-label"] }, "secret-label"],
    [
      {
        function: "extract",
        schema: {
          "secret-key": { type: "string" },
          ...Object.fromEntries(
            Array.from({ length: 256 }, (_, i) => [
              `k${i}`,
              { type: "string" },
            ]),
          ),
        },
      },
      "secret-key",
    ],
    [
      {
        function: "decide",
        questions: {
          "secret-q": {
            type: "score",
            instructions: "secret-instructions",
            criteria: ["only"],
          },
        },
      },
      "secret",
    ],
    // These would leak if the formatter's <key> masking or namesKeys rule regressed:
    [
      {
        function: "decide",
        questions: {
          "secret-q": { type: "noul", instructions: "?", "secret-extra": 1 },
        },
      },
      "secret",
    ],
    [
      { function: "classify", labels: { "secret-label": 5, other: "x" } },
      "secret-label",
    ],
    [{ function: "extract", schema: ["secret-a", 5] }, "secret-a"],
  ])(
    "never echoes labels, schema keys, question ids, or content in errors (%#)",
    (task, secret) => {
      let message = "";
      try {
        prepareTask(task);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(secret);
    },
  );
});

describe("TASK_NAME_PATTERN", () => {
  it.each(["routeTicket", "a", "invoice_fields-v2", "A".repeat(64)])(
    "accepts %s",
    (name) => {
      expect(TASK_NAME_PATTERN.test(name)).toBe(true);
    },
  );
  it.each(["", "1task", "__proto__", "has space", "a.b", "A".repeat(65)])(
    "rejects %s",
    (name) => {
      expect(TASK_NAME_PATTERN.test(name)).toBe(false);
    },
  );
});

describe("parseTaskInput", () => {
  it("accepts exactly content or state", () => {
    expect(parseTaskInput("classify", { content: "hi" })).toEqual({
      content: "hi",
    });
    expect(parseTaskInput("decide", { state: { a: 1 } })).toEqual({
      state: { a: 1 },
    });
  });

  it("rejects extra keys with the unknown-key message", () => {
    expect(() =>
      parseTaskInput("classify", { content: "hi", labels: ["x"] }),
    ).toThrow('unrecognized_keys: request has unknown key "labels"');
  });

  it("reports the unknown key even when the input field is missing", () => {
    // zod lists invalid_union (missing content) first; parseTaskInput prefers the unknown key.
    expect(() => parseTaskInput("classify", { state: "x" })).toThrow(
      'unrecognized_keys: request has unknown key "state"',
    );
  });

  it("rejects empty content and wrong fields as 400s", () => {
    for (const [fn, input] of [
      ["classify", { content: "  " }],
      ["extract", { state: "x" }],
      ["decide", { content: "x" }],
      ["decide", "not an object"],
    ] as const) {
      expect(() => parseTaskInput(fn, input)).toThrow(AiFunctionsRequestError);
    }
  });
});
