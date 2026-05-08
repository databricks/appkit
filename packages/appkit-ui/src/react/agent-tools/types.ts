import type { AgentToolDefinition, ToolAnnotations } from "shared";

/**
 * Configuration object passed to {@link useAgentTool}. The shape mirrors the
 * server-side `tool({...})` factory and the `AgentToolDefinition` carried on
 * the wire — same `name`, `description`, `parameters` (JSON Schema),
 * `annotations` — plus an `execute` callback that runs in the browser when
 * the agent invokes this tool.
 *
 * Tools are scoped to the React subtree they live in: registration happens
 * on mount, deregistration on unmount. The currently-rendered UI is
 * therefore the agent's tool surface for the next chat request.
 *
 * `parameters` is accepted as a raw JSON Schema for the PoC. A Zod-flavoured
 * sugar (`schema: ZodSchema`) is planned for the productionised PR 1.
 */
export interface UseAgentToolConfig {
  /**
   * LLM-visible tool name. Must be unique across the registered catalog at
   * the moment the next chat request is sent. Names that collide with the
   * agent's static (plugin / function / MCP) tools are rejected by the
   * server with a synchronous 400.
   */
  name: string;
  /** Short, action-oriented description shown to the LLM during tool selection. */
  description: string;
  /**
   * JSON Schema for the tool arguments. Use the Draft-07 dialect; the
   * server passes this through to the model as-is.
   */
  parameters: AgentToolDefinition["parameters"];
  /** Optional semantic hints (effect, idempotence, ...). See `ToolAnnotations`. */
  annotations?: ToolAnnotations;
  /**
   * Browser-side handler. Receives the LLM-supplied arguments and returns
   * the value to feed back to the agent loop. Throwing or rejecting becomes
   * a structured error — the LLM sees the message as the tool result, not
   * a runtime crash.
   */
  execute: (args: Record<string, unknown>) => unknown | Promise<unknown>;
}

/**
 * Internal record stored in the registry once a hook has registered a
 * tool. The `execute` callback is held by reference so unmount tear-down
 * leaves no stale closures behind.
 */
export interface RegisteredClientTool {
  def: AgentToolDefinition;
  execute: UseAgentToolConfig["execute"];
}

/**
 * Outcome of a client-tool dispatch. Mirrors the wire shape posted to
 * `/chat/client-tool-result`: either a JSON-serialisable `result` or a
 * structured `error` string. The error string is what the LLM sees as the
 * tool output, so it should be human-readable and contain no secrets.
 */
export type ClientToolDispatchOutcome =
  | { kind: "ok"; result: unknown }
  | { kind: "error"; error: string };
