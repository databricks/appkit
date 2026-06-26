import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type { AgentToolDefinition } from "shared";
import { AgentElementRegistry } from "./element-registry";
import { ClientToolRegistry } from "./registry";
import { dispatchUiCall, synthesizeUiCatalog } from "./synthesize";
import type { ClientToolDispatchOutcome } from "./types";
import { useAgentToolChannel } from "./use-agent-tool-channel";
import { isUiToolName } from "./verbs";

/** Default mount point for the agents plugin's HTTP routes. */
const DEFAULT_API_BASE = "/api/agents";

function newSessionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `s-${Math.random().toString(36).slice(2)}`;
}

/**
 * Context exposed to descendants of an `<AgentToolsProvider>`. Holds two
 * registries by reference:
 *
 * - `tools` — raw tools added via `useAgentTool` (custom components).
 * - `elements` — interactive elements registered by core appkit-ui
 *   components via `useAgentElement`, from which the flattened verb tools
 *   (`click`, `set_value`, …) + `ui_snapshot` are synthesized.
 *
 * Both are refs (not state) so registration doesn't re-render the whole
 * provider; consumers read the merged catalog via `useAgentToolCatalog`,
 * which subscribes to both through `useSyncExternalStore`.
 */
interface AgentToolsContextValue {
  tools: ClientToolRegistry;
  elements: AgentElementRegistry;
  /** Per-tab session id; sent on chat requests and used by the tool channel. */
  sessionId: string;
}

const AgentToolsContext = createContext<AgentToolsContextValue | null>(null);

export interface AgentToolsProviderProps {
  children: ReactNode;
  /** Optional pre-built tool registry (tests, advanced sharing). */
  registry?: ClientToolRegistry;
  /** Optional pre-built element registry (tests, advanced sharing). */
  elementRegistry?: AgentElementRegistry;
  /** Base path for the agents plugin routes. @default "/api/agents" */
  apiBase?: string;
  /**
   * Open the persistent tool channel that registers this tab's catalog and
   * receives agent/MCP tool calls. Disable for tests or chat-only setups.
   * @default true
   */
  channel?: boolean;
}

/**
 * Wrap the React subtree that should expose tools to the agent. Core
 * appkit-ui components inside it become agent-addressable automatically;
 * `useAgentTool(...)` adds bespoke tools. The chat hook
 * (`useAgentToolCatalog` + `useDispatchClientTool`) reads from this provider
 * to build the per-request `uiTools` payload and to dispatch
 * `appkit.client_tool_call` events.
 *
 * Multiple providers are supported (nesting, side-by-side panes); each
 * subtree sees only its own tools and elements. Unmounting the provider drops
 * both registries — there is no global singleton state.
 */
export function AgentToolsProvider({
  children,
  registry,
  elementRegistry,
  apiBase = DEFAULT_API_BASE,
  channel = true,
}: AgentToolsProviderProps): ReactNode {
  const ownedTools = useRef<ClientToolRegistry | null>(null);
  if (!ownedTools.current) {
    ownedTools.current = registry ?? new ClientToolRegistry();
  }
  const ownedElements = useRef<AgentElementRegistry | null>(null);
  if (!ownedElements.current) {
    ownedElements.current = elementRegistry ?? new AgentElementRegistry();
  }
  const sessionRef = useRef<string>("");
  if (!sessionRef.current) sessionRef.current = newSessionId();

  const tools = registry ?? (ownedTools.current as ClientToolRegistry);
  const elements =
    elementRegistry ?? (ownedElements.current as AgentElementRegistry);
  const sessionId = sessionRef.current;

  // Hold the persistent channel open: register this tab's catalog and execute
  // agent/MCP-initiated tool calls. Shared substrate for in-app chat and MCP.
  useAgentToolChannel({
    tools,
    elements,
    apiBase,
    sessionId,
    enabled: channel,
  });

  const value = useMemo<AgentToolsContextValue>(
    () => ({ tools, elements, sessionId }),
    [tools, elements, sessionId],
  );

  return (
    <AgentToolsContext.Provider value={value}>
      {children}
    </AgentToolsContext.Provider>
  );
}

function useAgentToolsContext(hookName: string): AgentToolsContextValue {
  const ctx = useContext(AgentToolsContext);
  if (!ctx) {
    throw new Error(
      `${hookName} must be used inside an <AgentToolsProvider>. ` +
        "Wrap the part of your app that registers UI tools (or runs the chat hook).",
    );
  }
  return ctx;
}

/**
 * Returns the raw-tool registry. Most callers want
 * {@link useAgentToolCatalog} or {@link useDispatchClientTool}; this backs
 * {@link useAgentTool} and is the escape hatch for tests and bespoke hooks.
 */
export function useClientToolRegistry(): ClientToolRegistry {
  return useAgentToolsContext("useClientToolRegistry").tools;
}

/**
 * Returns the element registry, or `null` when called outside an
 * `<AgentToolsProvider>`. Backs {@link useAgentElement}, which is baked into
 * core components and therefore must not throw when an app doesn't use the
 * agent-tools layer at all.
 */
export function useOptionalAgentElementRegistry(): AgentElementRegistry | null {
  return useContext(AgentToolsContext)?.elements ?? null;
}

/**
 * Snapshot of the live tool catalog for the next chat request's `uiTools`
 * field: the synthesized element verbs (`click`, `set_value`, …) +
 * `ui_snapshot`, merged with raw `useAgentTool` tools. Re-renders only when
 * the catalog's shape changes (element mount/unmount/id change, raw-tool
 * add/remove) — not when live element state (input values, checked) changes,
 * since that lives in the snapshot result rather than the catalog.
 */
export function useAgentToolCatalog(): AgentToolDefinition[] {
  const { tools, elements } = useAgentToolsContext("useAgentToolCatalog");
  const cached = useRef<{ key: string; value: AgentToolDefinition[] }>({
    key: "",
    value: [],
  });
  return useSyncExternalStore(
    (listener) => {
      const a = tools.subscribe(listener);
      const b = elements.subscribe(listener);
      return () => {
        a();
        b();
      };
    },
    () => {
      const raw = tools.catalog();
      const key = `${elements.registrationKey()}##${raw.map((t) => t.name).join(",")}`;
      if (key === cached.current.key) return cached.current.value;
      const value = synthesizeUiCatalog(elements, raw);
      cached.current = { key, value };
      return value;
    },
    () => cached.current.value,
  );
}

/**
 * Returns a stable callback that dispatches a tool by name and returns its
 * outcome. Routing:
 *
 * - `ui_snapshot` → the live element inventory.
 * - a verb (`click`, `set_value`, …) → the targeted element's handler.
 * - anything else → a raw `useAgentTool` tool.
 *
 * Use it from a chat hook to handle `appkit.client_tool_call` SSE events:
 *
 *   const dispatch = useDispatchClientTool();
 *   const outcome = await dispatch(toolName, args);
 *   await fetch('/api/agents/client-tool-result', {
 *     method: 'POST',
 *     body: JSON.stringify({ streamId, callId, ...outcome }),
 *   });
 */
export function useDispatchClientTool(): (
  name: string,
  args: Record<string, unknown>,
) => Promise<ClientToolDispatchOutcome> {
  const { tools, elements } = useAgentToolsContext("useDispatchClientTool");
  return useMemo(
    () => (name: string, args: Record<string, unknown>) =>
      dispatchUiCall(name, args, tools, elements),
    [tools, elements],
  );
}

/**
 * The current tab's tool-session id. Send it on chat requests (`sessionId`)
 * so the agent uses this tab's registered catalog and delivers tool calls over
 * its channel.
 */
export function useAgentSessionId(): string {
  return useAgentToolsContext("useAgentSessionId").sessionId;
}

/** Re-exported for consumers that need to detect synthesized tool names. */
export { isUiToolName };
