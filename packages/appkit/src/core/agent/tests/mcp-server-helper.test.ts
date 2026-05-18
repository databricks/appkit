import { describe, expect, test } from "vitest";
import {
  isHostedTool,
  mcpServer,
  resolveHostedTools,
} from "../../../core/agent/tools/hosted-tools";

describe("mcpServer()", () => {
  test("returns a CustomMcpServerTool with correct shape", () => {
    const result = mcpServer("my-app", "https://example.com/mcp");

    expect(result).toEqual({
      type: "custom_mcp_server",
      custom_mcp_server: {
        app_name: "my-app",
        app_url: "https://example.com/mcp",
      },
    });
  });

  test("isHostedTool recognizes mcpServer() output", () => {
    expect(isHostedTool(mcpServer("x", "y"))).toBe(true);
  });

  test("resolveHostedTools resolves mcpServer() output to an endpoint config", () => {
    const configs = resolveHostedTools([
      mcpServer("vector-search", "https://host/mcp/vs"),
    ]);

    expect(configs).toHaveLength(1);
    expect(configs[0].name).toBe("vector-search");
    expect(configs[0].url).toBe("https://host/mcp/vs");
  });
});
