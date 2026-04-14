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
  resolvedUrl: string;
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
  private sessionIds = new Map<string, string>();
  private requestId = 0;
  private closed = false;

  constructor(
    private workspaceHost: string,
    private authenticate: () => Promise<Record<string, string>>,
  ) {}

  async connectAll(endpoints: McpEndpointConfig[]): Promise<void> {
    const results = await Promise.allSettled(
      endpoints.map((ep) => this.connect(ep)),
    );
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === "rejected") {
        logger.error(
          "Failed to connect MCP server %s: %O",
          endpoints[i].name,
          (results[i] as PromiseRejectedResult).reason,
        );
      }
    }
  }

  private resolveUrl(endpoint: McpEndpointConfig): string {
    if (
      endpoint.url.startsWith("http://") ||
      endpoint.url.startsWith("https://")
    ) {
      return endpoint.url;
    }
    return `${this.workspaceHost}${endpoint.url}`;
  }

  async connect(endpoint: McpEndpointConfig): Promise<void> {
    const url = this.resolveUrl(endpoint);
    logger.info("Connecting to MCP server: %s at %s", endpoint.name, url);

    const initResponse = await this.sendRpc(url, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "appkit-agent", version: "0.1.0" },
    });

    if (initResponse.sessionId) {
      this.sessionIds.set(endpoint.name, initResponse.sessionId);
    }
    const sessionId = this.sessionIds.get(endpoint.name);

    await this.sendNotification(url, "notifications/initialized", sessionId);

    const listResponse = await this.sendRpc(
      url,
      "tools/list",
      {},
      { sessionId },
    );
    const toolList =
      (listResponse.result as { tools?: McpToolSchema[] })?.tools ?? [];

    const tools = new Map<string, McpToolSchema>();
    for (const tool of toolList) {
      tools.set(tool.name, tool);
    }

    this.connections.set(endpoint.name, {
      config: endpoint,
      resolvedUrl: url,
      tools,
    });
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

    const sessionId = this.sessionIds.get(serverName);
    const rpcResult = await this.sendRpc(
      conn.resolvedUrl,
      "tools/call",
      { name: toolName, arguments: args },
      { authOverride: authHeaders, sessionId },
    );
    const result = rpcResult.result as McpToolCallResult;

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
    url: string,
    method: string,
    params?: Record<string, unknown>,
    options?: {
      authOverride?: Record<string, string>;
      sessionId?: string;
    },
  ): Promise<{ result: unknown; sessionId?: string }> {
    if (this.closed) throw new Error("MCP client is closed");

    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: ++this.requestId,
      method,
      ...(params && { params }),
    };

    const authHeaders = options?.authOverride ?? (await this.authenticate());
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...authHeaders,
    };
    if (options?.sessionId) {
      headers["Mcp-Session-Id"] = options.sessionId;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(
        `MCP request to ${method} failed: ${response.status} ${response.statusText}`,
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    let json: JsonRpcResponse;

    if (contentType.includes("text/event-stream")) {
      const text = await response.text();
      const lastData = text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .pop();
      if (!lastData) {
        throw new Error(`MCP SSE response for ${method} contained no data`);
      }
      json = JSON.parse(lastData) as JsonRpcResponse;
    } else {
      json = (await response.json()) as JsonRpcResponse;
    }

    if (json.error) {
      throw new Error(`MCP error (${json.error.code}): ${json.error.message}`);
    }

    const sid = response.headers.get("mcp-session-id") ?? undefined;
    return { result: json.result, sessionId: sid };
  }

  private async sendNotification(
    url: string,
    method: string,
    sessionId?: string,
  ): Promise<void> {
    if (this.closed) return;

    const authHeaders = await this.authenticate();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...authHeaders,
    };
    if (sessionId) {
      headers["Mcp-Session-Id"] = sessionId;
    }

    await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", method }),
      signal: AbortSignal.timeout(30_000),
    });
  }
}
