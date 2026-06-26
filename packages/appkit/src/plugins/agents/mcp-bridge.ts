import type express from "express";
import type { AgentToolDefinition } from "shared";

/**
 * Dependencies the MCP bridge needs from the agents plugin, kept as callbacks
 * so this module stays decoupled from the plugin internals (and from the
 * `@modelcontextprotocol/sdk` import, which is loaded lazily).
 */
export interface McpBridgeDeps {
  serverName: string;
  serverVersion: string;
  /**
   * The browser session an external MCP client should drive. Returns the
   * most-recently-active connected tab, or null when none is connected.
   */
  resolveSession: () => {
    sessionId: string;
    userId: string;
    tools: AgentToolDefinition[];
  } | null;
  /** Round-trip a tool call to the resolved tab and return its result. */
  callTool: (args: {
    sessionId: string;
    userId: string;
    name: string;
    args: Record<string, unknown>;
  }) => Promise<unknown>;
}

/**
 * Bridges external MCP clients (Claude Code, Cursor, scripts) to a connected
 * browser tab's live UI tools. `tools/list` returns the tab's registered
 * catalog; `tools/call` round-trips the call through the same channel + gate
 * the in-app agent uses — so the same tools drive the same UI, just from a
 * different initiator.
 *
 * Stateless Streamable HTTP: a fresh server + transport per request, reading
 * the live session each time. The SDK is imported lazily (and cached) so it is
 * only loaded when the bridge is actually enabled.
 */
export class McpBridge {
  private sdk: ReturnType<McpBridge["loadSdk"]> | null = null;

  constructor(private readonly deps: McpBridgeDeps) {}

  private loadSdk() {
    return (async () => {
      const [serverMod, transportMod, typesMod] = await Promise.all([
        import("@modelcontextprotocol/sdk/server/index.js"),
        import("@modelcontextprotocol/sdk/server/streamableHttp.js"),
        import("@modelcontextprotocol/sdk/types.js"),
      ]);
      return {
        Server: serverMod.Server,
        StreamableHTTPServerTransport:
          transportMod.StreamableHTTPServerTransport,
        ListToolsRequestSchema: typesMod.ListToolsRequestSchema,
        CallToolRequestSchema: typesMod.CallToolRequestSchema,
      };
    })();
  }

  async handle(req: express.Request, res: express.Response): Promise<void> {
    if (!this.sdk) this.sdk = this.loadSdk();
    const {
      Server,
      StreamableHTTPServerTransport,
      ListToolsRequestSchema,
      CallToolRequestSchema,
    } = await this.sdk;

    const server = new Server(
      { name: this.deps.serverName, version: this.deps.serverVersion },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const session = this.deps.resolveSession();
      return {
        tools: (session?.tools ?? []).map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.parameters as { type: "object"; [k: string]: unknown },
        })),
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const session = this.deps.resolveSession();
      if (!session) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: "No browser tab is connected. Open the app in a browser, then retry.",
            },
          ],
        };
      }
      try {
        const result = await this.deps.callTool({
          sessionId: session.sessionId,
          userId: session.userId,
          name: request.params.name,
          args: (request.params.arguments ?? {}) as Record<string, unknown>,
        });
        const text =
          typeof result === "string" ? result : JSON.stringify(result);
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: err instanceof Error ? err.message : String(err),
            },
          ],
        };
      }
    });

    // Stateless: no session id, fresh transport per request.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }
}
