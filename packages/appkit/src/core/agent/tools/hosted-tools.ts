import type { McpEndpointConfig } from "../../../connectors/mcp";

export interface GenieTool {
  type: "genie-space";
  genie_space: { id: string };
}

export interface VectorSearchIndexTool {
  type: "vector_search_index";
  vector_search_index: { name: string };
}

export interface CustomMcpServerTool {
  type: "custom_mcp_server";
  custom_mcp_server: { app_name: string; app_url: string };
}

export interface ExternalMcpServerTool {
  type: "external_mcp_server";
  external_mcp_server: { connection_name: string };
}

export type HostedTool =
  | GenieTool
  | VectorSearchIndexTool
  | CustomMcpServerTool
  | ExternalMcpServerTool;

const HOSTED_TOOL_TYPES = new Set([
  "genie-space",
  "vector_search_index",
  "custom_mcp_server",
  "external_mcp_server",
]);

export function isHostedTool(value: unknown): value is HostedTool {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.type === "string" && HOSTED_TOOL_TYPES.has(obj.type);
}

/**
 * Resolves HostedTool configs into MCP endpoint configurations
 * that the MCP client can connect to.
 */
function resolveHostedTool(tool: HostedTool): McpEndpointConfig {
  switch (tool.type) {
    case "genie-space":
      return {
        name: `genie-${tool.genie_space.id}`,
        url: `/api/2.0/mcp/genie/${tool.genie_space.id}`,
      };
    case "vector_search_index": {
      const parts = tool.vector_search_index.name.split(".");
      if (parts.length !== 3) {
        throw new Error(
          `vector_search_index name must be 3-part dotted (catalog.schema.index), got: ${tool.vector_search_index.name}`,
        );
      }
      return {
        name: `vs-${parts.join("-")}`,
        url: `/api/2.0/mcp/vector-search/${parts[0]}/${parts[1]}/${parts[2]}`,
      };
    }
    case "custom_mcp_server":
      return {
        name: tool.custom_mcp_server.app_name,
        url: tool.custom_mcp_server.app_url,
      };
    case "external_mcp_server":
      return {
        name: tool.external_mcp_server.connection_name,
        url: `/api/2.0/mcp/external/${tool.external_mcp_server.connection_name}`,
      };
  }
}

export function resolveHostedTools(tools: HostedTool[]): McpEndpointConfig[] {
  return tools.map(resolveHostedTool);
}

/**
 * Factory for declaring a custom MCP server tool.
 *
 * Replaces the verbose `{ type: "custom_mcp_server", custom_mcp_server: { app_name, app_url } }`
 * wrapper with a concise positional call.
 *
 * Example:
 * ```ts
 * mcpServer("my-app", "https://my-app.databricksapps.com/mcp")
 * ```
 */
export function mcpServer(name: string, url: string): CustomMcpServerTool {
  return {
    type: "custom_mcp_server",
    custom_mcp_server: { app_name: name, app_url: url },
  };
}
