import { describe, expect, test } from "vitest";
import type {
  CustomMcpServerTool,
  ExternalMcpServerTool,
  GenieTool,
  HostedTool,
  VectorSearchIndexTool,
} from "../hosted-tools";
import { isHostedTool } from "../hosted-tools";

const genieTool: GenieTool = {
  type: "genie",
  genie_space: { id: "space-123" },
};

const vectorSearchTool: VectorSearchIndexTool = {
  type: "vector_search_index",
  vector_search_index: { name: "catalog.schema.my_index" },
};

const customMcpTool: CustomMcpServerTool = {
  type: "custom_mcp_server",
  custom_mcp_server: { app_name: "my-mcp-app", app_url: "my-mcp-app" },
};

const externalMcpTool: ExternalMcpServerTool = {
  type: "external_mcp_server",
  external_mcp_server: { connection_name: "my-connection" },
};

describe("isHostedTool", () => {
  test("returns true for GenieTool", () => {
    expect(isHostedTool(genieTool)).toBe(true);
  });

  test("returns true for VectorSearchIndexTool", () => {
    expect(isHostedTool(vectorSearchTool)).toBe(true);
  });

  test("returns true for CustomMcpServerTool", () => {
    expect(isHostedTool(customMcpTool)).toBe(true);
  });

  test("returns true for ExternalMcpServerTool", () => {
    expect(isHostedTool(externalMcpTool)).toBe(true);
  });

  test("returns false for FunctionTool", () => {
    const functionTool = {
      type: "function",
      name: "test",
      execute: async () => "result",
    };
    expect(isHostedTool(functionTool)).toBe(false);
  });

  test("returns false for null/undefined", () => {
    expect(isHostedTool(null)).toBe(false);
    expect(isHostedTool(undefined)).toBe(false);
  });

  test("returns false for object with unknown type", () => {
    expect(isHostedTool({ type: "unknown_tool" })).toBe(false);
  });

  test("returns false for non-object", () => {
    expect(isHostedTool("genie")).toBe(false);
    expect(isHostedTool(42)).toBe(false);
  });
});

describe("hosted tool types", () => {
  test("all hosted tools satisfy HostedTool union", () => {
    const tools: HostedTool[] = [
      genieTool,
      vectorSearchTool,
      customMcpTool,
      externalMcpTool,
    ];

    expect(tools).toHaveLength(4);
    for (const tool of tools) {
      expect(isHostedTool(tool)).toBe(true);
    }
  });

  test("can be mixed in an array with discriminator", () => {
    const tools: HostedTool[] = [genieTool, vectorSearchTool];
    const types = tools.map((t) => t.type);
    expect(types).toEqual(["genie", "vector_search_index"]);
  });
});
