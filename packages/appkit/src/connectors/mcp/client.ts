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

/**
 * Hard cap on the size of a single MCP response body, including SSE
 * frames bundled into one HTTP response. MCP `initialize` / `tools/list`
 * / `tools/call` responses are JSON-RPC payloads — single-digit kilobytes
 * in normal use. A response anywhere near this size signals either a
 * misbehaving server or an attempt to exhaust client memory; we'd rather
 * fail loudly than allocate unbounded buffers from a remote.
 */
const MCP_RESPONSE_BODY_LIMIT_BYTES = 1024 * 1024;

/**
 * Read a fetch Response body into a string with a hard size cap. Aborts
 * and throws if the cumulative bytes read cross {@link
 * MCP_RESPONSE_BODY_LIMIT_BYTES}, so a remote server cannot keep
 * streaming data past the limit. Returns the empty string when the
 * response has no readable body.
 */
/**
 * Empty-object fallback used when an MCP server ships a missing or
 * malformed `inputSchema`. Matches the shape downstream adapters expect
 * for a function tool that takes no arguments.
 */
const EMPTY_TOOL_PARAMETERS: AgentToolDefinition["parameters"] = {
  type: "object",
  properties: {},
};

/**
 * Coerce a remote MCP server's reported `inputSchema` into the
 * JSONSchema7 shape AppKit's adapters expect for a function tool's
 * `parameters`. The MCP wire type is `Record<string, unknown>`, so a
 * misbehaving (or malicious) server could ship arbitrary JSON. We accept
 * only the standard `{ type: "object", properties: {...} }` shape and
 * fall back to an empty-parameters schema otherwise — the tool still
 * registers, it just can't accept arguments.
 */
function coerceToolParameters(
  inputSchema: Record<string, unknown> | undefined,
): AgentToolDefinition["parameters"] {
  if (!inputSchema || typeof inputSchema !== "object") {
    return EMPTY_TOOL_PARAMETERS;
  }
  const { type, properties } = inputSchema;
  if (type !== "object") return EMPTY_TOOL_PARAMETERS;
  if (
    properties !== undefined &&
    (typeof properties !== "object" ||
      properties === null ||
      Array.isArray(properties))
  ) {
    return EMPTY_TOOL_PARAMETERS;
  }
  return inputSchema as AgentToolDefinition["parameters"];
}

async function readResponseTextCapped(
  response: Response,
  maxBytes: number,
  contextLabel: string,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let total = 0;
  let out = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(
          `MCP ${contextLabel}: response body exceeded ${maxBytes} bytes — refusing to allocate unbounded buffer from a remote server.`,
        );
      }
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return out;
}

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

/**
 * Per-endpoint outcome of {@link AppKitMcpClient.connectAll}. Callers (the
 * agents plugin in particular) use the split to warn at startup when some
 * MCP servers are unreachable without aborting boot for the rest.
 */
export interface McpConnectAllResult {
  connected: string[];
  failed: Array<{ name: string; error: Error }>;
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

  /**
   * Connects every endpoint in parallel and returns a structured summary so
   * callers can distinguish "all connected" from "some failed".
   *
   * Returning the result instead of throwing is deliberate: one
   * misconfigured MCP server should not take down the entire agents plugin
   * at boot, and the agents plugin uses the summary to warn at startup with
   * the failed-endpoint names. Errors are also logged here so a caller
   * that ignores the return still gets per-endpoint diagnostics.
   *
   * @returns `connected` lists the endpoint names that initialised
   *   successfully; `failed` carries `{ name, error }` for the rest.
   */
  async connectAll(
    endpoints: McpEndpointConfig[],
  ): Promise<McpConnectAllResult> {
    const results = await Promise.allSettled(
      endpoints.map((ep) => this.connect(ep)),
    );
    const out: McpConnectAllResult = { connected: [], failed: [] };
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const name = endpoints[i].name;
      if (r.status === "fulfilled") {
        out.connected.push(name);
      } else {
        const error =
          r.reason instanceof Error ? r.reason : new Error(String(r.reason));
        logger.error("Failed to connect MCP server %s: %O", name, error);
        out.failed.push({ name, error });
      }
    }
    return out;
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
          parameters: coerceToolParameters(schema.inputSchema),
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

    // `text` is optional on `McpToolCallResult.content[]` per the MCP
    // spec; filtering only on `type === "text"` lets `c.text` be
    // `undefined`, which `Array.join` would render as the literal
    // string `"undefined"` and ship to the agent. Narrow on both
    // fields so the joined string only contains real text.
    const textContent = (result.content ?? []).filter(
      (c): c is { type: "text"; text: string } =>
        c.type === "text" && typeof c.text === "string",
    );

    if (result.isError) {
      const errText = textContent.map((c) => c.text).join("\n");
      throw new Error(errText || "MCP tool call failed");
    }

    return textContent.map((c) => c.text).join("\n");
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
    // Always read the body via the capped helper so a misconfigured or
    // malicious server can't exhaust client memory by streaming an
    // unbounded payload. Applies to both SSE (`response.text()` would
    // have buffered the whole stream) and plain JSON (`response.json()`
    // does the same internally).
    const bodyText = await readResponseTextCapped(
      response,
      MCP_RESPONSE_BODY_LIMIT_BYTES,
      method,
    );
    let json: JsonRpcResponse;

    if (contentType.includes("text/event-stream")) {
      const lastData = bodyText
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .pop();
      if (!lastData) {
        throw new Error(`MCP SSE response for ${method} contained no data`);
      }
      json = JSON.parse(lastData) as JsonRpcResponse;
    } else {
      if (bodyText.length === 0) {
        throw new Error(`MCP response for ${method} had an empty body`);
      }
      json = JSON.parse(bodyText) as JsonRpcResponse;
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
    // MCP notifications are fire-and-forget per spec — we don't throw on
    // failure. But silently swallowing 4xx/5xx hides server-side
    // rejections that would otherwise look like a successful connect()
    // followed by mysterious tool-call failures. Surface the bad status
    // via the logger so the dev sees it without breaking the protocol
    // contract.
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", method }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        logger.warn(
          "MCP notification %s to %s returned %d %s — the server may have rejected the request, but per MCP spec notifications are fire-and-forget and the connection is considered established.",
          method,
          url,
          response.status,
          response.statusText,
        );
      }
    } catch (err) {
      logger.warn(
        "MCP notification %s to %s failed before a response was received: %O",
        method,
        url,
        err,
      );
    }
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
