import type express from "express";
import type { AppKitMcpClient } from "../../connectors/mcp";
import type { PluginContext } from "../../core/plugin-context";
import type { ResolvedToolEntry } from "./types";

interface ToolDispatchContext {
  /**
   * The originating HTTP request. Used by `toolkit` entries to scope execution
   * to the caller's user context (`asUser(req)`) and by `mcp` entries to pick
   * up the OBO bearer token from `x-forwarded-access-token`.
   */
  req: express.Request;
  /** Cancellation signal, forwarded to the tool implementation. */
  signal: AbortSignal;
  /**
   * PluginContext mediator — required to dispatch `toolkit` entries. Absent in
   * unit tests that construct `AgentsPlugin` directly; callers may pass
   * `null` / `undefined`, in which case toolkit calls throw a clear error.
   */
  pluginContext?: PluginContext | null;
  /** Live MCP client. Required for `mcp` entries. */
  mcpClient?: AppKitMcpClient | null;
  /**
   * Delegates a sub-agent invocation. The closure owns the recursion depth so
   * the dispatcher itself remains depth-agnostic — the top-level caller
   * passes `depth = 1`, and a sub-agent's inner dispatcher passes `depth + 1`.
   */
  runSubAgent: (agentName: string, args: unknown) => Promise<unknown>;
}

/**
 * Fan-out a resolved tool entry to the correct executor. One place to add a
 * fifth `source` variant; `never`-typed default forces every caller to
 * update in lockstep.
 *
 * This only handles dispatch — result normalisation (`normalizeToolResult`),
 * budget counting, and approval gating remain at the call site, where each
 * stream has different policies.
 */
export async function dispatchToolCall(
  entry: ResolvedToolEntry,
  args: unknown,
  ctx: ToolDispatchContext,
): Promise<unknown> {
  switch (entry.source) {
    case "toolkit": {
      if (!ctx.pluginContext) {
        throw new Error(
          "Plugin tool execution requires PluginContext; " +
            "this should never happen through createApp.",
        );
      }
      return ctx.pluginContext.executeTool(
        ctx.req,
        entry.pluginName,
        entry.localName,
        args,
        ctx.signal,
      );
    }
    case "function":
      return entry.functionTool.execute(args as Record<string, unknown>);
    case "mcp": {
      if (!ctx.mcpClient) throw new Error("MCP client not connected");
      return ctx.mcpClient.callTool(
        entry.mcpToolName,
        args,
        extractOboMcpAuth(ctx.req),
      );
    }
    case "subagent":
      return ctx.runSubAgent(entry.agentName, args);
    default: {
      // Exhaustiveness guard: adding a new `source` to ResolvedToolEntry
      // without teaching this switch breaks the build here.
      const _exhaustive: never = entry;
      throw new Error(
        `Unsupported tool source: ${(_exhaustive as ResolvedToolEntry).source}`,
      );
    }
  }
}

/**
 * Extracts the caller's OBO bearer token from the standard Databricks Apps
 * forwarded-auth header. MCP destinations that `forwardWorkspaceAuth` admits
 * as same-origin will receive this header; non-workspace destinations drop
 * it inside {@link AppKitMcpClient.callTool}.
 */
function extractOboMcpAuth(
  req: express.Request,
): Record<string, string> | undefined {
  const oboToken = req.headers["x-forwarded-access-token"];
  return typeof oboToken === "string"
    ? { Authorization: `Bearer ${oboToken}` }
    : undefined;
}
