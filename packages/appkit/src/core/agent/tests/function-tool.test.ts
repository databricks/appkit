import { describe, expect, test } from "vitest";
import {
  functionToolToDefinition,
  isFunctionTool,
} from "../tools/function-tool";

describe("isFunctionTool", () => {
  test("returns true for valid FunctionTool", () => {
    expect(
      isFunctionTool({
        type: "function",
        name: "greet",
        execute: async () => "hello",
      }),
    ).toBe(true);
  });

  test("returns true for minimal FunctionTool", () => {
    expect(
      isFunctionTool({
        type: "function",
        name: "x",
        execute: () => "y",
      }),
    ).toBe(true);
  });

  test("returns false for null", () => {
    expect(isFunctionTool(null)).toBe(false);
  });

  test("returns false for non-object", () => {
    expect(isFunctionTool("function")).toBe(false);
  });

  test("returns false for wrong type", () => {
    expect(
      isFunctionTool({
        type: "genie-space",
        name: "x",
        execute: () => "y",
      }),
    ).toBe(false);
  });

  test("returns false when execute is missing", () => {
    expect(isFunctionTool({ type: "function", name: "x" })).toBe(false);
  });

  test("returns true when name is omitted (record key wins downstream)", () => {
    // Regression: previously `tool({ description, schema, execute })` (no
    // name) produced a FunctionTool whose `name: undefined` failed this
    // guard and broke registration with "unrecognized shape". The agents
    // plugin always overrides `name` with the record key from
    // `tools: { my_tool: tool({...}) }`, so requiring `name` here was
    // rejecting valid input.
    expect(isFunctionTool({ type: "function", execute: () => "y" })).toBe(true);
  });
});

describe("functionToolToDefinition", () => {
  test("converts a FunctionTool with all fields", () => {
    const def = functionToolToDefinition({
      type: "function",
      name: "getWeather",
      description: "Get current weather",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
      execute: async () => "sunny",
    });

    expect(def.name).toBe("getWeather");
    expect(def.description).toBe("Get current weather");
    expect(def.parameters).toEqual({
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    });
  });

  test("uses name as fallback description", () => {
    const def = functionToolToDefinition({
      type: "function",
      name: "myTool",
      execute: async () => "result",
    });

    expect(def.description).toBe("myTool");
  });

  test("uses empty object schema when parameters are null", () => {
    const def = functionToolToDefinition({
      type: "function",
      name: "noParams",
      parameters: null,
      execute: async () => "ok",
    });

    expect(def.parameters).toEqual({ type: "object", properties: {} });
  });

  test("uses empty object schema when parameters are omitted", () => {
    const def = functionToolToDefinition({
      type: "function",
      name: "noParams",
      execute: async () => "ok",
    });

    expect(def.parameters).toEqual({ type: "object", properties: {} });
  });
});
