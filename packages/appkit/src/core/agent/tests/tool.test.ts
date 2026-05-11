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
      description: "Echoes the input message back to the caller.",
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
      description: "Get weather for a city.",
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
      description: "Multi-arg tool used to exercise multi-issue zod errors.",
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
      description: "Returns the note when provided, '(no note)' otherwise.",
      schema: z.object({ note: z.string().optional() }),
      execute: async ({ note }) => note ?? "(no note)",
    });

    expect(await t.execute({})).toBe("(no note)");
    expect(await t.execute({ note: "hello" })).toBe("hello");
  });

  test("description is required and passes through verbatim", () => {
    // Earlier versions allowed `description` to be omitted and silently
    // fell back to `config.name`. That surfaced cryptic identifiers like
    // "get_weather" as the description; the LLM then either skipped the
    // tool or called it speculatively. The field is now mandatory at the
    // type level — TS catches the omission at authoring time instead of
    // pushing the cost of a confused agent into production.
    const t = tool({
      name: "my_tool",
      description: "Returns the string 'ok' verbatim.",
      schema: z.object({}),
      execute: async () => "ok",
    });

    expect(t.description).toBe("Returns the string 'ok' verbatim.");
    expect(t.parameters).toBeDefined();
  });

  test("name is optional — agents plugin overrides it with the record key", () => {
    // Regression: PR #306 reviewer hit a runtime crash because the
    // template wrote `tool({ description, schema, execute })` (no name)
    // and the FunctionTool shape guard rejected the result. The agent
    // runtime always overrides `name` with the record key in
    // `tools: { my_tool: tool({...}) }`, so requiring it here was
    // mis-shaping a valid input.
    const t = tool({
      description: "Returns the current server time",
      schema: z.object({}),
      execute: () => "2026-05-11T00:00:00Z",
    });

    expect(t.type).toBe("function");
    expect(t.name).toBeUndefined();
    expect(t.description).toBe("Returns the current server time");
  });

  test("execute may return non-string shapes; downstream normalises", async () => {
    // Regression: `execute` was typed `Promise<string> | string` but the
    // template's tools naturally return objects. The runtime serialises
    // via `normalizeToolResult`; tighten typing to `unknown` and verify
    // the value flows through.
    const t = tool({
      name: "now",
      description: "Returns the current timestamp as an ISO 8601 string.",
      schema: z.object({}),
      execute: () => ({ now: "2026-05-11T00:00:00Z" }),
    });
    const result = (await t.execute({})) as { now: string };
    expect(result).toEqual({ now: "2026-05-11T00:00:00Z" });
  });

  test("zod-error message uses a generic label when name is omitted", async () => {
    const t = tool({
      description: "needs a city",
      schema: z.object({ city: z.string() }),
      execute: () => "ok",
    });
    const result = await t.execute({});
    expect(typeof result).toBe("string");
    expect(result).toContain("Invalid arguments for tool");
    expect(result).toContain("city");
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
