import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import {
  defineTool,
  executeFromRegistry,
  type ToolRegistry,
  toolsFromRegistry,
} from "../tools/define-tool";

describe("defineTool()", () => {
  test("returns an entry matching the input config", () => {
    const entry = defineTool({
      description: "echo",
      schema: z.object({ msg: z.string() }),
      annotations: { readOnly: true },
      execute: ({ msg }) => msg,
    });

    expect(entry.description).toBe("echo");
    expect(entry.annotations).toEqual({ readOnly: true });
    expect(typeof entry.execute).toBe("function");
  });
});

describe("executeFromRegistry", () => {
  const registry: ToolRegistry = {
    echo: defineTool({
      description: "echo",
      schema: z.object({ msg: z.string() }),
      execute: ({ msg }) => `got ${msg}`,
    }),
  };

  test("validates args and calls execute on success", async () => {
    const result = await executeFromRegistry(registry, "echo", { msg: "hi" });
    expect(result).toBe("got hi");
  });

  test("returns formatted error string on validation failure", async () => {
    const result = await executeFromRegistry(registry, "echo", {});
    expect(typeof result).toBe("string");
    expect(result).toContain("Invalid arguments for echo");
    expect(result).toContain("msg");
  });

  test("throws for unknown tool names", async () => {
    await expect(executeFromRegistry(registry, "missing", {})).rejects.toThrow(
      /Unknown tool: missing/,
    );
  });

  test("forwards AbortSignal to the execute callback", async () => {
    const execute = vi.fn(async (_args: { x: string }, signal?: AbortSignal) =>
      signal?.aborted ? "aborted" : "ok",
    );
    const reg: ToolRegistry = {
      t: defineTool({
        description: "t",
        schema: z.object({ x: z.string() }),
        execute,
      }),
    };

    const controller = new AbortController();
    controller.abort();
    await executeFromRegistry(reg, "t", { x: "hi" }, controller.signal);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][1]).toBe(controller.signal);
  });
});

describe("toolsFromRegistry", () => {
  test("produces AgentToolDefinition[] with JSON Schema parameters", () => {
    const registry: ToolRegistry = {
      query: defineTool({
        description: "Execute a SQL query",
        schema: z.object({
          query: z.string().describe("SQL query"),
        }),
        annotations: { readOnly: true, requiresUserContext: true },
        execute: () => "ok",
      }),
    };

    const defs = toolsFromRegistry(registry);
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe("query");
    expect(defs[0].description).toBe("Execute a SQL query");
    expect(defs[0].parameters).toMatchObject({
      type: "object",
      properties: {
        query: { type: "string", description: "SQL query" },
      },
      required: ["query"],
    });
    expect(defs[0].annotations).toEqual({
      readOnly: true,
      requiresUserContext: true,
    });
  });

  test("preserves dotted names like uploads.list from the registry keys", () => {
    const registry: ToolRegistry = {
      "uploads.list": defineTool({
        description: "list uploads",
        schema: z.object({}),
        execute: () => [],
      }),
      "documents.list": defineTool({
        description: "list documents",
        schema: z.object({}),
        execute: () => [],
      }),
    };

    const names = toolsFromRegistry(registry).map((d) => d.name);
    expect(names).toContain("uploads.list");
    expect(names).toContain("documents.list");
  });

  test("omits annotations when none are provided", () => {
    const registry: ToolRegistry = {
      plain: defineTool({
        description: "plain",
        schema: z.object({}),
        execute: () => "ok",
      }),
    };
    const [def] = toolsFromRegistry(registry);
    expect(def.annotations).toBeUndefined();
  });
});
