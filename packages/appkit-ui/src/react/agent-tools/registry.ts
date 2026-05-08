import type { AgentToolDefinition } from "shared";
import type { ClientToolDispatchOutcome, RegisteredClientTool } from "./types";

/**
 * In-memory registry of UI tools provided by the React tree. Lives inside
 * an `<AgentToolsProvider>`; one registry per provider instance so multiple
 * isolated chat panes (e.g. nested agent UIs) don't cross-contaminate.
 *
 * The registry is intentionally small and dependency-free: it is a `Map`
 * with a notification mechanism so the chat hook can rebuild its catalog
 * snapshot on registry changes. No reactivity-framework primitives, no
 * stores — the React state lives where it should (in the `AgentToolsProvider`
 * component) and the registry is the imperative side-channel that
 * `useAgentTool` writes to.
 */
export class ClientToolRegistry {
  private tools = new Map<string, RegisteredClientTool>();
  private listeners = new Set<() => void>();

  register(entry: RegisteredClientTool): () => void {
    const { def } = entry;
    if (this.tools.has(def.name)) {
      // Replacing a tool of the same name happens during fast-refresh and
      // when a component remounts at a different position in the tree.
      // Both are fine — overwrite silently. A real prod build would warn.
    }
    this.tools.set(def.name, entry);
    this.emitChange();
    return () => {
      const current = this.tools.get(def.name);
      if (current === entry) {
        this.tools.delete(def.name);
        this.emitChange();
      }
    };
  }

  /**
   * Snapshot the catalog as `AgentToolDefinition[]` for inclusion in the
   * next chat request body. Returns a plain array; the chat hook is
   * expected to JSON-stringify it without further transformation.
   */
  catalog(): AgentToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.def);
  }

  /**
   * Dispatch a tool call by name. Errors are caught and returned as
   * `{ kind: "error" }` rather than thrown — the chat hook posts the
   * outcome to `/chat/client-tool-result` either way, and bubbling
   * exceptions to React's render path would tear down the chat UI.
   */
  async dispatch(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ClientToolDispatchOutcome> {
    const entry = this.tools.get(name);
    if (!entry) {
      return {
        kind: "error",
        error: `Tool '${name}' is not registered (component unmounted before dispatch?)`,
      };
    }
    try {
      const result = await entry.execute(args);
      return { kind: "ok", result };
    } catch (err) {
      return {
        kind: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emitChange(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Listener errors are swallowed — a broken consumer must not
        // prevent other listeners (or future registrations) from
        // working.
      }
    }
  }
}
