import { describe, expect, test } from "vitest";
import { z } from "zod";
import { formatZodError, tool } from "../tools/tool";

describe("tool()", () => {
  test("produces a FunctionTool with JSON Schema parameters from the Zod schema", () => {
    const weather = tool({
      name: "get_weather",
      description: "Get the current weather for a city",
      schema: z.object({
        city: z.string().describe("City name"),
      }),
      execute: async ({ city }) => `Sunny in ${city}`,
    });

    expect(weather.type).toBe("function");
    expect(weather.name).toBe("get_weather");
    expect(weather.description).toBe("Get the current weather for a city");
    expect(weather.parameters).toMatchObject({
      type: "object",
      properties: {
        city: { type: "string", description: "City name" },
      },
      required: ["city"],
    });
  });

  test("execute receives typed args on valid input", async () => {
    const echo = tool({
      name: "echo",
      schema: z.object({ message: z.string() }),
      execute: async ({ message }) => {
        const _typed: string = message;
        return `got ${_typed}`;
      },
    });

    const result = await echo.execute({ message: "hi" });
    expect(result).toBe("got hi");
  });

  test("returns formatted error string (does not throw) when args are invalid", async () => {
    const weather = tool({
      name: "get_weather",
      schema: z.object({ city: z.string() }),
      execute: async ({ city }) => `Sunny in ${city}`,
    });

    const result = await weather.execute({});
    expect(typeof result).toBe("string");
    expect(result).toContain("Invalid arguments for get_weather");
    expect(result).toContain("city");
  });

  test("joins multiple validation errors with '; '", async () => {
    const t = tool({
      name: "multi",
      schema: z.object({ a: z.string(), b: z.number() }),
      execute: async () => "ok",
    });

    const result = await t.execute({});
    expect(result).toContain("a:");
    expect(result).toContain("b:");
    expect(result).toContain(";");
  });

  test("optional fields validate when absent", async () => {
    const t = tool({
      name: "opt",
      schema: z.object({ note: z.string().optional() }),
      execute: async ({ note }) => note ?? "(no note)",
    });

    expect(await t.execute({})).toBe("(no note)");
    expect(await t.execute({ note: "hello" })).toBe("hello");
  });

  test("description falls back to the tool name when omitted", () => {
    const t = tool({
      name: "my_tool",
      schema: z.object({}),
      execute: async () => "ok",
    });

    expect(t.description).toBe("my_tool");
    expect(t.parameters).toBeDefined();
  });
});

describe("formatZodError", () => {
  test("formats a single issue with the tool name", () => {
    const schema = z.object({ city: z.string() });
    const result = schema.safeParse({});
    if (result.success) throw new Error("expected failure");

    const msg = formatZodError(result.error, "get_weather");
    expect(msg).toMatch(/^Invalid arguments for get_weather: /);
    expect(msg).toContain("city:");
  });

  test("joins multiple issues with '; '", () => {
    const schema = z.object({ a: z.string(), b: z.number() });
    const result = schema.safeParse({});
    if (result.success) throw new Error("expected failure");

    const msg = formatZodError(result.error, "t");
    expect(msg.split(";").length).toBeGreaterThanOrEqual(2);
  });
});
