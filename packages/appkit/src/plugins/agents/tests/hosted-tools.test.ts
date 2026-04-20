import { describe, expect, test } from "vitest";
import { isHostedTool, resolveHostedTools } from "../tools/hosted-tools";

describe("isHostedTool", () => {
  test("returns true for genie-space", () => {
    expect(
      isHostedTool({ type: "genie-space", genie_space: { id: "abc" } }),
    ).toBe(true);
  });

  test("returns true for vector_search_index", () => {
    expect(
      isHostedTool({
        type: "vector_search_index",
        vector_search_index: { name: "cat.schema.idx" },
      }),
    ).toBe(true);
  });

  test("returns true for custom_mcp_server", () => {
    expect(
      isHostedTool({
        type: "custom_mcp_server",
        custom_mcp_server: { app_name: "my-app", app_url: "my-app-url" },
      }),
    ).toBe(true);
  });

  test("returns true for external_mcp_server", () => {
    expect(
      isHostedTool({
        type: "external_mcp_server",
        external_mcp_server: { connection_name: "conn1" },
      }),
    ).toBe(true);
  });

  test("returns false for FunctionTool", () => {
    expect(
      isHostedTool({ type: "function", name: "x", execute: () => "y" }),
    ).toBe(false);
  });

  test("returns false for null", () => {
    expect(isHostedTool(null)).toBe(false);
  });

  test("returns false for unknown type", () => {
    expect(isHostedTool({ type: "unknown" })).toBe(false);
  });

  test("returns false for non-object", () => {
    expect(isHostedTool(42)).toBe(false);
  });
});

describe("resolveHostedTools", () => {
  test("resolves genie-space to correct MCP endpoint", () => {
    const configs = resolveHostedTools([
      { type: "genie-space", genie_space: { id: "space123" } },
    ]);

    expect(configs).toHaveLength(1);
    expect(configs[0].name).toBe("genie-space123");
    expect(configs[0].url).toBe("/api/2.0/mcp/genie/space123");
  });

  test("resolves vector_search_index with 3-part name", () => {
    const configs = resolveHostedTools([
      {
        type: "vector_search_index",
        vector_search_index: { name: "catalog.schema.my_index" },
      },
    ]);

    expect(configs).toHaveLength(1);
    expect(configs[0].name).toBe("vs-catalog-schema-my_index");
    expect(configs[0].url).toBe(
      "/api/2.0/mcp/vector-search/catalog/schema/my_index",
    );
  });

  test("throws for invalid vector_search_index name", () => {
    expect(() =>
      resolveHostedTools([
        {
          type: "vector_search_index",
          vector_search_index: { name: "bad.name" },
        },
      ]),
    ).toThrow("3-part dotted");
  });

  test("resolves custom_mcp_server", () => {
    const configs = resolveHostedTools([
      {
        type: "custom_mcp_server",
        custom_mcp_server: { app_name: "my-app", app_url: "my-app-endpoint" },
      },
    ]);

    expect(configs[0].name).toBe("my-app");
    expect(configs[0].url).toBe("my-app-endpoint");
  });

  test("resolves external_mcp_server", () => {
    const configs = resolveHostedTools([
      {
        type: "external_mcp_server",
        external_mcp_server: { connection_name: "conn1" },
      },
    ]);

    expect(configs[0].name).toBe("conn1");
    expect(configs[0].url).toBe("/api/2.0/mcp/external/conn1");
  });

  test("resolves multiple tools preserving order", () => {
    const configs = resolveHostedTools([
      { type: "genie-space", genie_space: { id: "g1" } },
      {
        type: "external_mcp_server",
        external_mcp_server: { connection_name: "e1" },
      },
    ]);

    expect(configs).toHaveLength(2);
    expect(configs[0].name).toBe("genie-g1");
    expect(configs[1].name).toBe("e1");
  });
});
