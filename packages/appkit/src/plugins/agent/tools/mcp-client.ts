import type { AgentToolDefinition } from "shared";
import { createLogger } from "../../../logging/logger";
import type { McpEndpointConfig } from "./hosted-tools";

const logger = createLogger("agent:mcp");

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface McpToolSchema {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface McpToolCallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

interface McpServerConnection {
  config: McpEndpointConfig;
  tools: Map<string, McpToolSchema>;
}

/**
 * Lightweight MCP client for Databricks-hosted MCP servers.
 *
 * Uses raw fetch() with JSON-RPC 2.0 over HTTP — no @modelcontextprotocol/sdk
 * or LangChain dependency. Supports the Streamable HTTP transport (POST with
 * JSON-RPC request, single JSON-RPC response).
 */
export class AppKitMcpClient {
  private connections = new Map<string, McpServerConnection>();
  private requestId = 0;
  private closed = false;

  constructor(
    private workspaceHost: string,
    private authenticate: () => Promise<Record<string, string>>,
  ) {}

  async connectAll(endpoints: McpEndpointConfig[]): Promise<void> {
    await Promise.all(endpoints.map((ep) => this.connect(ep)));
  }

  async connect(endpoint: McpEndpointConfig): Promise<void> {
    logger.info(
      "Connecting to MCP server: %s at %s",
      endpoint.name,
      endpoint.path,
    );

    await this.sendRpc(endpoint.path, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "appkit-agent", version: "0.1.0" },
    });

    await this.sendNotification(endpoint.path, "notifications/initialized");

    const result = await this.sendRpc(endpoint.path, "tools/list", {});
    const toolList = (result as { tools?: McpToolSchema[] })?.tools ?? [];

    const tools = new Map<string, McpToolSchema>();
    for (const tool of toolList) {
      tools.set(tool.name, tool);
    }

    this.connections.set(endpoint.name, { config: endpoint, tools });
    logger.info(
      "Connected to MCP server %s: %d tools available",
      endpoint.name,
      tools.size,
    );
  }

  getAllToolDefinitions(): AgentToolDefinition[] {
    const defs: AgentToolDefinition[] = [];
    for (const [serverName, conn] of this.connections) {
      for (const [toolName, schema] of conn.tools) {
        defs.push({
          name: `mcp.${serverName}.${toolName}`,
          description: schema.description ?? toolName,
          parameters:
            (schema.inputSchema as AgentToolDefinition["parameters"]) ?? {
              type: "object",
              properties: {},
            },
        });
      }
    }
    return defs;
  }

  async callTool(
    qualifiedName: string,
    args: unknown,
    authHeaders?: Record<string, string>,
  ): Promise<string> {
    const parts = qualifiedName.split(".");
    if (parts.length < 3 || parts[0] !== "mcp") {
      throw new Error(`Invalid MCP tool name: ${qualifiedName}`);
    }
    const serverName = parts[1];
    const toolName = parts.slice(2).join(".");

    const conn = this.connections.get(serverName);
    if (!conn) {
      throw new Error(`MCP server not connected: ${serverName}`);
    }

    const result = (await this.sendRpc(
      conn.config.path,
      "tools/call",
      { name: toolName, arguments: args },
      authHeaders,
    )) as McpToolCallResult;

    if (result.isError) {
      const errText = result.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      throw new Error(errText || "MCP tool call failed");
    }

    return result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }

  async close(): Promise<void> {
    this.closed = true;
    this.connections.clear();
  }

  private async sendRpc(
    path: string,
    method: string,
    params?: Record<string, unknown>,
    authOverride?: Record<string, string>,
  ): Promise<unknown> {
    if (this.closed) throw new Error("MCP client is closed");

    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: ++this.requestId,
      method,
      ...(params && { params }),
    };

    const url = `${this.workspaceHost}${path}`;
    const authHeaders = authOverride ?? (await this.authenticate());

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...authHeaders,
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(
        `MCP request to ${method} failed: ${response.status} ${response.statusText}`,
      );
    }

    const json = (await response.json()) as JsonRpcResponse;
    if (json.error) {
      throw new Error(`MCP error (${json.error.code}): ${json.error.message}`);
    }

    return json.result;
  }

  private async sendNotification(path: string, method: string): Promise<void> {
    if (this.closed) return;

    const url = `${this.workspaceHost}${path}`;
    const authHeaders = await this.authenticate();

    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...authHeaders,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method }),
    });
  }
}
