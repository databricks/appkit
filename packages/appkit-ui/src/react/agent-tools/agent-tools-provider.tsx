import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type { AgentToolDefinition } from "shared";
import { ClientToolRegistry } from "./registry";
import type { ClientToolDispatchOutcome } from "./types";

/**
 * Context exposed to descendants of an `<AgentToolsProvider>`. The
 * `registry` is held by reference so `useAgentTool` can register/unregister
 * synchronously without going through React state. The catalog is read
 * via `useAgentToolCatalog` which subscribes to registry changes through
 * `useSyncExternalStore`, keeping consumers in sync without re-rendering
 * the entire provider on every registration.
 */
interface AgentToolsContextValue {
  registry: ClientToolRegistry;
}

const AgentToolsContext = createContext<AgentToolsContextValue | null>(null);

export interface AgentToolsProviderProps {
  children: ReactNode;
  /**
   * Optional pre-built registry. Useful for tests that want to inject a
   * fresh registry per render, or for advanced cases that need to share a
   * single registry across multiple providers. When omitted, the provider
   * creates and owns its own registry for the lifetime of the component.
   */
  registry?: ClientToolRegistry;
}

/**
 * Wrap the React subtree that should expose UI tools to the agent. Every
 * `useAgentTool(...)` call inside the subtree adds to this provider's
 * registry; the chat-hook (`useAgentToolCatalog` + `useDispatchClientTool`)
 * reads from it to build the per-request `uiTools` payload.
 *
 * Usage:
 *
 *   <AgentToolsProvider>
 *     <App />
 *   </AgentToolsProvider>
 *
 * Multiple providers are supported (nesting, side-by-side panes); each
 * subtree sees only the tools registered within it. Unmounting the
 * provider drops the registry — there is no global singleton state.
 */
export function AgentToolsProvider({
  children,
  registry,
}: AgentToolsProviderProps): ReactNode {
  // The registry must outlive renders, so it lives in a ref. We deliberately
  // do not put it in state: registering a tool would otherwise trigger a
  // re-render of every consumer, which is wasteful — `useSyncExternalStore`
  // gives us targeted re-renders only for components that read the catalog.
  const ownedRegistry = useRef<ClientToolRegistry | null>(null);
  if (!ownedRegistry.current) {
    ownedRegistry.current = registry ?? new ClientToolRegistry();
  }

  const value = useMemo<AgentToolsContextValue>(
    () => ({
      registry: registry ?? (ownedRegistry.current as ClientToolRegistry),
    }),
    [registry],
  );

  return (
    <AgentToolsContext.Provider value={value}>
      {children}
    </AgentToolsContext.Provider>
  );
}

/**
 * Internal: throw a clear error when a hook is called outside the
 * provider. Without this you'd see `Cannot read properties of null` from
 * deep inside `useAgentTool` and have to trace it back yourself.
 */
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
 * Returns the current registry instance. Most callers want
 * {@link useAgentToolCatalog} or {@link useDispatchClientTool} instead;
 * this is the escape hatch for tests and bespoke chat hooks.
 */
export function useClientToolRegistry(): ClientToolRegistry {
  return useAgentToolsContext("useClientToolRegistry").registry;
}

/**
 * Snapshot of the live tool catalog, suitable for inclusion in the
 * `uiTools` field of the next chat request. Re-renders on registry changes
 * via `useSyncExternalStore` — only components that actually read the
 * catalog re-render.
 *
 * The returned array is referentially stable across renders that don't
 * change the catalog, so passing it directly into `useEffect` deps or
 * memoised callbacks is safe.
 */
export function useAgentToolCatalog(): AgentToolDefinition[] {
  const { registry } = useAgentToolsContext("useAgentToolCatalog");
  // Cache the last-emitted snapshot so React's bail-out logic in
  // `useSyncExternalStore` works (`Object.is` comparison on the array
  // reference). Without this, every subscribe() invocation would build a
  // fresh array and force re-renders even when the catalog is unchanged.
  const cached = useRef<AgentToolDefinition[]>([]);
  return useSyncExternalStore(
    (listener) => registry.subscribe(listener),
    () => {
      const next = registry.catalog();
      const prev = cached.current;
      if (catalogEqual(prev, next)) return prev;
      cached.current = next;
      return next;
    },
    () => cached.current,
  );
}

/**
 * Returns a stable callback that dispatches a client tool by name. Use
 * this from a chat hook to handle `appkit.client_tool_call` SSE events:
 *
 *   const dispatch = useDispatchClientTool();
 *   ...
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
  const { registry } = useAgentToolsContext("useDispatchClientTool");
  // Bound method captured once. `registry` is referentially stable for
  // the provider's lifetime, so this callback is too.
  return useMemo(() => registry.dispatch.bind(registry), [registry]);
}

/**
 * Cheap shallow compare on `AgentToolDefinition[]` keyed by `name`. Two
 * catalogs with the same set of names in the same order are treated as
 * equal — registration order is deterministic enough that this is safe,
 * and tools whose `description` / `parameters` have changed will get new
 * names anyway in practice. Avoids the cost of deep equality on every
 * subscribe call from `useSyncExternalStore`.
 */
function catalogEqual(
  a: AgentToolDefinition[],
  b: AgentToolDefinition[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.name !== b[i]!.name) return false;
  }
  return true;
}
