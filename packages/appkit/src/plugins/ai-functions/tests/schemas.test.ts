import { describe, expect, it } from "vitest";

import { AiFunctionsRequestError } from "../errors";
import {
  parseClassifyRequest,
  parseDecideRequest,
  parseExtractRequest,
} from "../schemas";

function expectValidationError(
  operation: () => unknown,
  functionName: "classify" | "extract" | "decide",
  message: string,
): void {
  let error: unknown;
  try {
    operation();
  } catch (thrown) {
    error = thrown;
  }

  expect(error).toBeInstanceOf(AiFunctionsRequestError);
  expect(error).toMatchObject({
    code: "AI_FUNCTIONS_REQUEST_ERROR",
    statusCode: 400,
    functionName,
    isRetryable: false,
  });
  expect((error as AiFunctionsRequestError).message).toBe(message);
}

describe("AI Functions request schemas", () => {
  it("accepts documented classify request forms", () => {
    expect(
      parseClassifyRequest({
        content: "This package arrived damaged.",
        labels: ["negative", "neutral"],
      }),
    ).toMatchObject({ options: { version: "2.1" } });

    expect(
      parseClassifyRequest({
        content: "This package arrived damaged.",
        labels: {
          negative: "Dissatisfied customer",
          neutral: "No clear sentiment",
        },
      }),
    ).toMatchObject({ options: { version: "2.1" } });

    expect(
      parseClassifyRequest({
        content: {
          document: {
            elements: [{ type: "text", content: "Parsed document text" }],
          },
        },
        labels: ["invoice", "contract"],
      }),
    ).toMatchObject({ options: { version: "2.1" } });
  });

  it("accepts documented extract request forms", () => {
    expect(
      parseExtractRequest({
        content: "Acme raised $10 million.",
        schema: ["company", "amount"],
      }),
    ).toMatchObject({ options: { version: "2.1" } });

    expect(
      parseExtractRequest({
        content: "Acme raised $10 million.",
        schema: {
          company: { type: "string", description: "Company name" },
          amount: { type: "number", description: "Amount raised" },
        },
        options: { mode: "precision", enable_citations: true },
      }),
    ).toMatchObject({
      options: { version: "2.1", mode: "precision", enable_citations: true },
    });
  });

  it("accepts documented decide request forms", () => {
    expect(
      parseDecideRequest({
        state: { message: "The customer reports suspected fraud." },
        questions: {
          team: {
            type: "choice",
            instructions: "Which team should handle this?",
            criteria: {
              billing: "Payments, charges, and refunds",
              technical_support: null,
            },
          },
          escalate: {
            type: "noul",
            instructions: "Does this need escalation?",
            criteria: {
              true: "Fraud or policy exception",
              false: "Routine issue",
            },
          },
          urgency: {
            type: "score",
            instructions: "Rate the urgency.",
            criteria: ["Routine", "Time-sensitive", "Critical"],
          },
        },
      }),
    ).toMatchObject({ options: { version: "1.0" } });
  });

  it.each([
    {
      parser: parseClassifyRequest,
      request: {
        content: "text",
        labels: ["first", "second"],
        options: { version: undefined },
      },
      version: "2.1",
    },
    {
      parser: parseExtractRequest,
      request: {
        content: "text",
        schema: ["field"],
        options: { version: undefined },
      },
      version: "2.1",
    },
    {
      parser: parseDecideRequest,
      request: {
        state: "state",
        questions: {
          question: {
            type: "score",
            instructions: "Rate this",
            criteria: ["low", "high"],
          },
        },
        options: { version: undefined },
      },
      version: "1.0",
    },
  ])(
    "injects version $version when it is explicitly undefined",
    ({ parser, request, version }) => {
      expect(parser(request)).toMatchObject({ options: { version } });
    },
  );

  it.each([
    {
      request: { content: "text", labels: ["only"] },
      message: "too_small: labels must have at least 2 items",
    },
    {
      request: {
        content: "text",
        labels: Array.from({ length: 501 }, (_, i) => `${i}`),
      },
      message: "too_big: labels must have at most 500 items",
    },
    {
      request: { content: "text", labels: ["", "valid"] },
      message: "too_small: labels.<key> must have at least 1 character",
    },
    {
      request: { content: "text", labels: ["a".repeat(101), "valid"] },
      message: "too_big: labels.<key> must have at most 100 characters",
    },
    {
      request: { content: "text", labels: { only: "One label" } },
      message: "labels must contain between 2 and 500 entries",
    },
  ])("rejects invalid classify labels", ({ request, message }) => {
    expectValidationError(
      () => parseClassifyRequest(request),
      "classify",
      message,
    );
  });

  it("rejects instructions longer than 20,000 characters", () => {
    expectValidationError(
      () =>
        parseClassifyRequest({
          content: "text",
          labels: ["first", "second"],
          options: { instructions: "😀".repeat(20_001) },
        }),
      "classify",
      "instructions must not exceed 20000 code points",
    );
  });

  it("accepts instructions with 20,000 code points", () => {
    expect(
      parseClassifyRequest({
        content: "text",
        labels: ["first", "second"],
        options: { instructions: "😀".repeat(20_000) },
      }),
    ).toMatchObject({ options: { version: "2.1" } });
  });

  it.each([
    {
      parser: parseClassifyRequest,
      request: { content: "", labels: ["a", "b"] },
      functionName: "classify" as const,
    },
    {
      parser: parseClassifyRequest,
      request: { content: "  \n", labels: ["a", "b"] },
      functionName: "classify" as const,
    },
    {
      parser: parseExtractRequest,
      request: { content: "", schema: ["field"] },
      functionName: "extract" as const,
    },
  ])(
    "rejects empty $functionName content",
    ({ parser, request, functionName }) => {
      let error: unknown;
      try {
        parser(request);
      } catch (thrown) {
        error = thrown;
      }
      expect(error).toBeInstanceOf(AiFunctionsRequestError);
      expect(error).toMatchObject({ statusCode: 400, functionName });
    },
  );

  it("names unknown option keys and hints at snake_case", () => {
    expectValidationError(
      () =>
        parseClassifyRequest({
          content: "text",
          labels: ["first", "second"],
          options: { enableConfidenceScores: true },
        }),
      "classify",
      'unrecognized_keys: options has unknown key "enableConfidenceScores"; use snake_case, such as "enable_confidence_scores"',
    );
  });

  it("rejects array classify content", () => {
    expectValidationError(
      () =>
        parseClassifyRequest({
          content: ["not", "allowed"],
          labels: ["first", "second"],
        }),
      "classify",
      "invalid_union: content",
    );
  });

  it.each([
    {
      parser: parseClassifyRequest,
      request: {
        content: "text",
        labels: ["first", "second"],
        options: { version: "2.0" },
      },
      functionName: "classify" as const,
    },
    {
      parser: parseExtractRequest,
      request: {
        content: "text",
        schema: ["field"],
        options: { version: "2.0" },
      },
      functionName: "extract" as const,
    },
    {
      parser: parseDecideRequest,
      request: {
        state: "state",
        questions: {
          question: {
            type: "score",
            instructions: "Rate this",
            criteria: ["low", "high"],
          },
        },
        options: { version: "2.1" },
      },
      functionName: "decide" as const,
    },
    {
      parser: parseClassifyRequest,
      request: {
        content: "text",
        labels: ["first", "second"],
        options: { version: null },
      },
      functionName: "classify" as const,
    },
    {
      parser: parseExtractRequest,
      request: {
        content: "text",
        schema: ["field"],
        options: { version: null },
      },
      functionName: "extract" as const,
    },
    {
      parser: parseDecideRequest,
      request: {
        state: "state",
        questions: {
          question: {
            type: "score",
            instructions: "Rate this",
            criteria: ["low", "high"],
          },
        },
        options: { version: null },
      },
      functionName: "decide" as const,
    },
  ])(
    "rejects unsupported or null caller versions",
    ({ parser, request, functionName }) => {
      expectValidationError(
        () => parser(request),
        functionName,
        `invalid_value: options.version must be "${functionName === "decide" ? "1.0" : "2.1"}"`,
      );
    },
  );

  it("reports validation failures as non-retryable 400 errors", () => {
    try {
      parseClassifyRequest({
        content: "text",
        labels: ["only"],
      });
      throw new Error("Expected parseClassifyRequest to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AiFunctionsRequestError);
      expect(error).toMatchObject({
        code: "AI_FUNCTIONS_REQUEST_ERROR",
        statusCode: 400,
        functionName: "classify",
        isRetryable: false,
        message: "too_small: labels must have at least 2 items",
      });
    }
  });

  it("does not expose label keys in validation messages", () => {
    const longLabel = `sensitive-label-${"a".repeat(101)}`;

    let error: unknown;
    try {
      parseClassifyRequest({
        content: "text",
        labels: { [longLabel]: "description", valid: "description" },
      });
    } catch (thrown) {
      error = thrown;
    }

    expect(error).toBeInstanceOf(AiFunctionsRequestError);
    expect((error as AiFunctionsRequestError).message).not.toContain(longLabel);
  });

  it("does not expose question fields in validation messages", () => {
    const extraQuestionField = "sensitive_question_field";

    let error: unknown;
    try {
      parseDecideRequest({
        state: "state",
        questions: {
          question: {
            type: "score",
            instructions: "Rate this",
            criteria: ["low", "high"],
            [extraQuestionField]: true,
          },
        },
      });
    } catch (thrown) {
      error = thrown;
    }

    expect(error).toBeInstanceOf(AiFunctionsRequestError);
    expect((error as AiFunctionsRequestError).message).not.toContain(
      extraQuestionField,
    );
  });

  it.each([
    {
      request: {
        content: "text",
        schema: Array.from({ length: 257 }, (_, i) => `${i}`),
      },
      message: "too_big: schema must have at most 256 items",
    },
    {
      request: {
        content: "text",
        schema: Object.fromEntries(
          Array.from({ length: 257 }, (_, i) => [
            `field_${i}`,
            { type: "string" },
          ]),
        ),
      },
      message: "schema must contain at most 256 entries",
    },
    {
      request: {
        content: "text",
        schema: ["field"],
        options: { mode: "fast" },
      },
      message: 'invalid_value: options.mode must be "precision"',
    },
  ])(
    "rejects invalid extract request limits and mode",
    ({ request, message }) => {
      expectValidationError(
        () => parseExtractRequest(request),
        "extract",
        message,
      );
    },
  );

  it.each([null, true, 1])("rejects an invalid decide state", (state) => {
    expectValidationError(
      () =>
        parseDecideRequest({
          state,
          questions: {
            question: {
              type: "score",
              instructions: "Rate this",
              criteria: ["low", "high"],
            },
          },
        }),
      "decide",
      "invalid_union: state",
    );
  });

  it.each([null, true, 1])(
    "rejects invalid decide instructions",
    (instructions) => {
      expectValidationError(
        () =>
          parseDecideRequest({
            state: "state",
            questions: {
              question: {
                type: "score",
                instructions,
                criteria: ["low", "high"],
              },
            },
          }),
        "decide",
        "invalid_union: questions.<key>.instructions",
      );
    },
  );

  it.each([
    {
      request: { state: "state", questions: {} },
      message: "questions must contain at least one entry",
    },
    {
      request: {
        state: "state",
        questions: {
          "": {
            type: "score",
            instructions: "Rate this",
            criteria: ["low", "high"],
          },
        },
      },
      message: "invalid_key: questions.<key>",
    },
    {
      request: {
        state: "state",
        questions: {
          question: { type: "choice", instructions: "Choose" },
        },
      },
      message: "invalid_type: questions.<key>.criteria",
    },
    {
      request: {
        state: "state",
        questions: {
          question: { type: "choice", instructions: "Choose", criteria: {} },
        },
      },
      message: "criteria must contain between 1 and 255 entries",
    },
    {
      request: {
        state: "state",
        questions: {
          question: {
            type: "choice",
            instructions: "Choose",
            criteria: Object.fromEntries(
              Array.from({ length: 256 }, (_, i) => [`option_${i}`, "value"]),
            ),
          },
        },
      },
      message: "criteria must contain between 1 and 255 entries",
    },
    {
      request: {
        state: "state",
        questions: {
          question: {
            type: "choice",
            instructions: "Choose",
            criteria: { "": "value" },
          },
        },
      },
      message: "invalid_key: questions.<key>.criteria.<key>",
    },
    {
      request: {
        state: "state",
        questions: {
          question: {
            type: "noul",
            instructions: "Escalate?",
            criteria: { maybe: "value" },
          },
        },
      },
      message: "unrecognized_keys: questions.<key>.criteria",
    },
    {
      request: {
        state: "state",
        questions: {
          question: {
            type: "score",
            instructions: "Rate this",
            criteria: ["only"],
          },
        },
      },
      message: "too_small: questions.<key>.criteria must have at least 2 items",
    },
    {
      request: {
        state: "state",
        questions: {
          question: {
            type: "score",
            instructions: "Rate this",
            criteria: Array.from({ length: 11 }, (_, i) => `${i}`),
          },
        },
      },
      message: "too_big: questions.<key>.criteria must have at most 10 items",
    },
  ])("rejects invalid decide questions", ({ request, message }) => {
    expectValidationError(() => parseDecideRequest(request), "decide", message);
  });

  it.each([
    {
      parser: parseClassifyRequest,
      request: { content: "text", labels: ["first", "second"], extra: true },
      functionName: "classify" as const,
      message: 'unrecognized_keys: request has unknown key "extra"',
    },
    {
      parser: parseClassifyRequest,
      request: {
        content: "text",
        labels: ["first", "second"],
        options: { unexpected: true },
      },
      functionName: "classify" as const,
      message: 'unrecognized_keys: options has unknown key "unexpected"',
    },
    {
      parser: parseExtractRequest,
      request: { content: "text", schema: ["field"], extra: true },
      functionName: "extract" as const,
      message: 'unrecognized_keys: request has unknown key "extra"',
    },
    {
      parser: parseExtractRequest,
      request: {
        content: "text",
        schema: ["field"],
        options: { unexpected: true },
      },
      functionName: "extract" as const,
      message: 'unrecognized_keys: options has unknown key "unexpected"',
    },
    {
      parser: parseDecideRequest,
      request: {
        state: "state",
        questions: {
          question: {
            type: "score",
            instructions: "Rate this",
            criteria: ["low", "high"],
          },
        },
        options: { unexpected: true },
      },
      functionName: "decide" as const,
      message: 'unrecognized_keys: options has unknown key "unexpected"',
    },
    {
      parser: parseDecideRequest,
      request: {
        state: "state",
        questions: {
          question: {
            type: "score",
            instructions: "Rate this",
            criteria: ["low", "high"],
          },
        },
        extra: true,
      },
      functionName: "decide" as const,
      message: 'unrecognized_keys: request has unknown key "extra"',
    },
  ])(
    "rejects unknown request and option fields",
    ({ parser, request, functionName, message }) => {
      expectValidationError(() => parser(request), functionName, message);
    },
  );
});
