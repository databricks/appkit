import { describe, expect, test } from "vitest";
import {
  convertRequestSchema,
  convertResponseSchema,
  deriveChunkType,
  extractRequestKeys,
} from "../converter";
import type { OpenApiOperation, OpenApiSchema } from "../fetcher";

function makeOperation(
  requestProps: Record<string, OpenApiSchema>,
  responseProps?: Record<string, OpenApiSchema>,
  required?: string[],
): OpenApiOperation {
  return {
    requestBody: {
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: requestProps,
            required,
          },
        },
      },
    },
    responses: responseProps
      ? {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: responseProps,
                },
              },
            },
          },
        }
      : undefined,
  };
}

describe("converter", () => {
  describe("convertRequestSchema", () => {
    test("converts string type", () => {
      const op = makeOperation({ name: { type: "string" } });
      const result = convertRequestSchema(op);
      expect(result).toContain("name?: string;");
    });

    test("converts integer type to number", () => {
      const op = makeOperation({ count: { type: "integer" } });
      expect(convertRequestSchema(op)).toContain("count?: number;");
    });

    test("converts number type", () => {
      const op = makeOperation({
        temp: { type: "number", format: "double" },
      });
      expect(convertRequestSchema(op)).toContain("temp?: number;");
    });

    test("converts boolean type", () => {
      const op = makeOperation({ flag: { type: "boolean" } });
      expect(convertRequestSchema(op)).toContain("flag?: boolean;");
    });

    test("converts enum to string literal union", () => {
      const op = makeOperation({
        role: { type: "string", enum: ["user", "assistant"] },
      });
      const result = convertRequestSchema(op);
      expect(result).toContain('"user" | "assistant"');
    });

    test("converts array type", () => {
      const op = makeOperation({
        items: { type: "array", items: { type: "string" } },
      });
      expect(convertRequestSchema(op)).toContain("items?: string[];");
    });

    test("converts nested object", () => {
      const op = makeOperation({
        messages: {
          type: "array",
          items: {
            type: "object",
            properties: {
              role: { type: "string" },
              content: { type: "string" },
            },
          },
        },
      });
      const result = convertRequestSchema(op);
      expect(result).toContain("role?: string;");
      expect(result).toContain("content?: string;");
    });

    test("handles nullable properties", () => {
      const op = makeOperation({
        temp: { type: "number", nullable: true },
      });
      expect(convertRequestSchema(op)).toContain("temp?: number | null;");
    });

    test("handles oneOf union types", () => {
      const op = makeOperation({
        stop: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
      });
      const result = convertRequestSchema(op);
      expect(result).toContain("string | string[]");
    });

    test("strips stream property from request", () => {
      const op = makeOperation({
        messages: { type: "array", items: { type: "string" } },
        stream: { type: "boolean", nullable: true },
        temperature: { type: "number" },
      });
      const result = convertRequestSchema(op);
      expect(result).not.toContain("stream");
      expect(result).toContain("messages");
      expect(result).toContain("temperature");
    });

    test("marks required properties without ?", () => {
      const op = makeOperation(
        {
          messages: { type: "array", items: { type: "string" } },
          temperature: { type: "number" },
        },
        undefined,
        ["messages"],
      );
      const result = convertRequestSchema(op);
      expect(result).toContain("messages: string[];");
      expect(result).toContain("temperature?: number;");
    });

    test("returns Record<string, unknown> for missing schema", () => {
      const op: OpenApiOperation = {};
      expect(convertRequestSchema(op)).toBe("Record<string, unknown>");
    });
  });

  describe("convertResponseSchema", () => {
    test("converts response schema", () => {
      const op = makeOperation(
        {},
        {
          model: { type: "string" },
          id: { type: "string" },
        },
      );
      const result = convertResponseSchema(op);
      expect(result).toContain("model?: string;");
      expect(result).toContain("id?: string;");
    });

    test("returns unknown for missing response", () => {
      const op: OpenApiOperation = {};
      expect(convertResponseSchema(op)).toBe("unknown");
    });
  });

  describe("deriveChunkType", () => {
    test("derives chunk type from OpenAI-compatible response", () => {
      const op: OpenApiOperation = {
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    model: { type: "string" },
                    choices: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          index: { type: "integer" },
                          message: {
                            type: "object",
                            properties: {
                              role: {
                                type: "string",
                                enum: ["user", "assistant"],
                              },
                              content: { type: "string" },
                            },
                          },
                          finish_reason: { type: "string" },
                        },
                      },
                    },
                    usage: {
                      type: "object",
                      properties: {
                        prompt_tokens: { type: "integer" },
                      },
                      nullable: true,
                    },
                    id: { type: "string" },
                  },
                },
              },
            },
          },
        },
      };

      const result = deriveChunkType(op);
      expect(result).not.toBeNull();
      // Should have delta instead of message
      expect(result).toContain("delta");
      expect(result).not.toContain("message");
      // Should make finish_reason nullable
      expect(result).toContain("finish_reason");
      expect(result).toContain("| null");
      // Should drop usage
      expect(result).not.toContain("usage");
      // Should keep model and id
      expect(result).toContain("model");
      expect(result).toContain("id");
    });

    test("returns null for non-OpenAI response (no choices)", () => {
      const op = makeOperation(
        {},
        {
          predictions: { type: "array", items: { type: "number" } },
        },
      );
      expect(deriveChunkType(op)).toBeNull();
    });

    test("returns null for choices without message", () => {
      const op: OpenApiOperation = {
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    choices: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          score: { type: "number" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      };
      expect(deriveChunkType(op)).toBeNull();
    });

    test("returns null for missing response", () => {
      const op: OpenApiOperation = {};
      expect(deriveChunkType(op)).toBeNull();
    });
  });

  describe("extractRequestKeys", () => {
    test("extracts top-level property keys excluding stream", () => {
      const op = makeOperation({
        messages: { type: "array", items: { type: "string" } },
        temperature: { type: "number" },
        stream: { type: "boolean", nullable: true },
      });
      expect(extractRequestKeys(op)).toEqual(["messages", "temperature"]);
    });

    test("returns empty array for missing schema", () => {
      const op: OpenApiOperation = {};
      expect(extractRequestKeys(op)).toEqual([]);
    });

    test("returns empty array for schema without properties", () => {
      const op: OpenApiOperation = {
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object" },
            },
          },
        },
      };
      expect(extractRequestKeys(op)).toEqual([]);
    });
  });
});
