/**
 * Custom MCP over HTTP (Streamable) — not `@modelcontextprotocol/sdk`
 *
 * This module implements a tiny JSON-RPC 2.0 client on `fetch` for the subset
 * of MCP we need: `initialize`, `notifications/initialized`, `tools/list`,
 * `tools/call` over a single JSON request/response. We do not use the official
 * SDK because:
 *
 * - **Policy and auth are the product** — every outbound URL is checked with
 *   {@link McpHostPolicy} (allowlist, DNS, private/blocked IP ranges) before
 *   the first byte is sent, and workspace tokens are only forwarded when
 *   `forwardWorkspaceAuth` is true for that destination. A generic transport
 *   from the SDK would still need the same hooks; re-wrapping it would be
 *   about as much code, with a larger third-party surface to audit.
 * - **Narrow scope** — we only target Databricks-hosted MCP over Streamable
 *   HTTP, not stdio, full SSE sessions, or the rest of the protocol. A
 *   hand-rolled path keeps the call graph obvious in code review.
 * - **Zero extra runtime dependency** for this path, consistent with other
 *   small, security-sensitive AppKit pieces.
 *
 * Revisit if we add more transports, or if the SDK ships a first-class way to
 * inject our host policy and per-URL auth without fighting the default
 * transport.
 */
import type { AgentToolDefinition } from "shared";
import { createLogger } from "../../logging/logger";
import {
  assertResolvedHostSafe,
  checkMcpUrl,
  type DnsLookup,
  type McpHostPolicy,
} from "./host-policy";
import type { McpEndpointConfig } from "./types";

const logger = createLogger("connector:mcp");

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
  /**
   * Whether workspace auth (SP / OBO) may be forwarded to this endpoint's URL.
   * Decided at `connect()` time via {@link McpHostPolicy} and cached for the
   * lifetime of the connection.
   */
  forwardWorkspaceAuth: boolean;
  tools: Map<string, McpToolSchema>;
}

/**
 * Lightweight MCP client for Databricks-hosted MCP servers.
 *
 * Uses raw fetch() with JSON-RPC 2.0 over HTTP — no @modelcontextprotocol/sdk
 * or LangChain dependency. Supports the Streamable HTTP transport only
 * (POST with JSON-RPC request, single JSON-RPC response). Implements exactly
 * four methods: `initialize`, `notifications/initialized`, `tools/list`,
 * `tools/call`. No prompts/resources/completion/sampling.
 *
 * All outbound URLs are gated by an {@link McpHostPolicy}: unallowlisted hosts
 * are rejected before the first byte is sent, and workspace credentials are
 * only forwarded to the same-origin workspace. See `mcp-host-policy.ts`.
 *
 * Rationale for hand-rolling JSON-RPC instead of `@modelcontextprotocol/sdk`:
 * see the file-level comment at the top of this module.
 */
export class AppKitMcpClient {
  private connections = new Map<string, McpServerConnection>();
  private sessionIds = new Map<string, string>();
  private requestId = 0;
  private closed = false;

  constructor(
    private workspaceHost: string,
    private authenticate: () => Promise<Record<string, string>>,
    private policy: McpHostPolicy,
    private options: { dnsLookup?: DnsLookup; fetchImpl?: typeof fetch } = {},
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
    const resolvedUrl = this.resolveUrl(endpoint);
    const check = checkMcpUrl(resolvedUrl, this.policy);
    if (!check.ok) {
      throw new Error(
        `MCP endpoint '${endpoint.name}' refused at connect: ${check.reason}`,
      );
    }
    await assertResolvedHostSafe(
      check.url.hostname,
      this.policy,
      this.options.dnsLookup,
    );

    logger.info(
      "Connecting to MCP server: %s at %s (forwardWorkspaceAuth=%s)",
      endpoint.name,
      resolvedUrl,
      check.forwardWorkspaceAuth,
    );

    const initResponse = await this.sendRpc(
      resolvedUrl,
      "initialize",
      {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "appkit-agent", version: "0.1.0" },
      },
      { forwardWorkspaceAuth: check.forwardWorkspaceAuth },
    );

    if (initResponse.sessionId) {
      this.sessionIds.set(endpoint.name, initResponse.sessionId);
    }
    const sessionId = this.sessionIds.get(endpoint.name);

    await this.sendNotification(resolvedUrl, "notifications/initialized", {
      sessionId,
      forwardWorkspaceAuth: check.forwardWorkspaceAuth,
    });

    const listResponse = await this.sendRpc(
      resolvedUrl,
      "tools/list",
      {},
      { sessionId, forwardWorkspaceAuth: check.forwardWorkspaceAuth },
    );
    const toolList =
      (listResponse.result as { tools?: McpToolSchema[] })?.tools ?? [];

    const tools = new Map<string, McpToolSchema>();
    for (const tool of toolList) {
      tools.set(tool.name, tool);
    }

    this.connections.set(endpoint.name, {
      config: endpoint,
      resolvedUrl,
      forwardWorkspaceAuth: check.forwardWorkspaceAuth,
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

  /**
   * Whether the named MCP server may receive workspace-scoped auth headers
   * (e.g., an OBO bearer token from an end-user request). Callers should gate
   * auth-forwarding decisions on this to prevent credential exfiltration to
   * non-workspace hosts.
   */
  canForwardWorkspaceAuth(serverName: string): boolean {
    return this.connections.get(serverName)?.forwardWorkspaceAuth ?? false;
  }

  async callTool(
    qualifiedName: string,
    args: unknown,
    authHeaders?: Record<string, string>,
    callerSignal?: AbortSignal,
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
    // authHeaders are caller-supplied credentials (typically the OBO token).
    // Only honor them if the destination URL was admitted with
    // forwardWorkspaceAuth=true at connect time.
    const scopedAuthOverride = conn.forwardWorkspaceAuth
      ? authHeaders
      : undefined;

    const rpcResult = await this.sendRpc(
      conn.resolvedUrl,
      "tools/call",
      { name: toolName, arguments: args },
      {
        authOverride: scopedAuthOverride,
        sessionId,
        forwardWorkspaceAuth: conn.forwardWorkspaceAuth,
        callerSignal,
      },
    );
    const result = rpcResult.result as McpToolCallResult;

    if (result.isError) {
      const errText = (result.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      throw new Error(errText || "MCP tool call failed");
    }

    return (result.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }

  async close(): Promise<void> {
    this.closed = true;
    this.connections.clear();
    this.sessionIds.clear();
  }

  private async sendRpc(
    url: string,
    method: string,
    params?: Record<string, unknown>,
    options?: {
      authOverride?: Record<string, string>;
      sessionId?: string;
      forwardWorkspaceAuth?: boolean;
      /**
       * Optional external abort signal (typically the agent's stream signal).
       * Composed with the built-in 30 s timeout so `/cancel` or agent-run
       * shutdown immediately propagates to the MCP fetch rather than waiting
       * for the remote server to respond.
       */
      callerSignal?: AbortSignal;
    },
  ): Promise<{ result: unknown; sessionId?: string }> {
    if (this.closed) throw new Error("MCP client is closed");

    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: ++this.requestId,
      method,
      ...(params && { params }),
    };

    const authHeaders = await this.resolveAuthHeaders(options);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...authHeaders,
    };
    if (options?.sessionId) {
      headers["Mcp-Session-Id"] = options.sessionId;
    }

    const fetchImpl = this.options.fetchImpl ?? fetch;
    const signals: AbortSignal[] = [AbortSignal.timeout(30_000)];
    if (options?.callerSignal) signals.push(options.callerSignal);
    const response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
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
    options?: {
      sessionId?: string;
      forwardWorkspaceAuth?: boolean;
    },
  ): Promise<void> {
    if (this.closed) return;

    const authHeaders = await this.resolveAuthHeaders(options);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...authHeaders,
    };
    if (options?.sessionId) {
      headers["Mcp-Session-Id"] = options.sessionId;
    }

    const fetchImpl = this.options.fetchImpl ?? fetch;
    await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", method }),
      signal: AbortSignal.timeout(30_000),
    });
  }

  /**
   * Return the auth headers to send on an outbound request. Workspace auth
   * (SP or OBO) is only resolved when `forwardWorkspaceAuth` is true; for
   * non-workspace hosts no bearer token is attached.
   */
  private async resolveAuthHeaders(options?: {
    authOverride?: Record<string, string>;
    forwardWorkspaceAuth?: boolean;
  }): Promise<Record<string, string>> {
    if (!options?.forwardWorkspaceAuth) return {};
    if (options.authOverride) return options.authOverride;
    return this.authenticate();
  }
}
