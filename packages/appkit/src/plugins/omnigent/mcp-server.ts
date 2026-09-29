import type { AgentToolDefinition, ToolEffect } from "shared";

/** One tool served over MCP, with where it came from. */
export interface McpTool {
  /** MCP-safe name (`[A-Za-z0-9_-]{1,64}`). */
  name: string;
  definition: AgentToolDefinition;
  run: (args: unknown, signal?: AbortSignal) => Promise<unknown>;
}

const WRITE_EFFECTS: ReadonlySet<ToolEffect> = new Set([
  "write",
  "update",
  "destructive",
]);

export function isWriteTool(def: AgentToolDefinition): boolean {
  const a = def.annotations;
  if (!a) return false;
  if (a.effect) return WRITE_EFFECTS.has(a.effect);
  return a.destructive === true || a.readOnly === false;
}

/** Maps an AppKit tool name (may contain dots) to an MCP-safe one. */
export function mcpToolName(name: string, prefix?: string): string {
  const raw = prefix ? `${prefix}__${name}` : name;
  return raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

type JsonRpcReply = Record<string, unknown>;

const MCP_PROTOCOL_VERSION = "2025-06-18";

/**
 * A stateless MCP server over plain JSON-RPC (streamable HTTP with JSON
 * responses): `initialize`, `ping`, `tools/list`, `tools/call`. The caller has
 * already authenticated the session key and set up the user context.
 */
export class McpToolServer {
  constructor(
    private readonly tools: () => McpTool[],
    private readonly info = { name: "appkit", version: "1" },
  ) {}

  /** Handles one JSON-RPC message; returns `null` when nothing needs a reply. */
  async handle(
    body: unknown,
    signal?: AbortSignal,
  ): Promise<JsonRpcReply | null> {
    const m = body as JsonRpcRequest;
    if (!m || typeof m !== "object" || typeof m.method !== "string") {
      return rpcError(null, -32600, "Invalid request");
    }
    const isNotification = m.id === undefined || m.id === null;
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: m.id, result });
    switch (m.method) {
      case "initialize":
        return reply({
          protocolVersion:
            typeof m.params?.protocolVersion === "string"
              ? m.params.protocolVersion
              : MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: this.info,
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({
          tools: this.tools().map((t) => ({
            name: t.name,
            description: t.definition.description,
            inputSchema: t.definition.parameters,
            annotations: {
              readOnlyHint: !isWriteTool(t.definition),
              destructiveHint:
                t.definition.annotations?.effect === "destructive",
            },
          })),
        });
      case "tools/call": {
        const name = String(m.params?.name ?? "");
        const tool = this.tools().find((t) => t.name === name);
        if (!tool)
          return rpcError(m.id ?? null, -32602, `Unknown tool: ${name}`);
        try {
          const out = await tool.run(m.params?.arguments ?? {}, signal);
          return reply({ content: [{ type: "text", text: asText(out) }] });
        } catch (err) {
          // Tool failures go back to the model as a tool result, not a protocol error.
          return reply({
            content: [
              {
                type: "text",
                text: err instanceof Error ? err.message : String(err),
              },
            ],
            isError: true,
          });
        }
      }
      default:
        if (isNotification) return null;
        return rpcError(m.id ?? null, -32601, `Method not found: ${m.method}`);
    }
  }
}

function asText(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function rpcError(id: unknown, code: number, message: string): JsonRpcReply {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
