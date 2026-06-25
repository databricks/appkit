import type { ClientToolDispatchOutcome } from "./types";

/**
 * One verb-action a UI element supports (e.g. a button's `click`, an input's
 * `set_value`). The agent-visible parameter schema for each verb is canonical
 * and lives in `VERB_DEFS` (see `verbs.ts`); a capability only needs to know
 * how to *perform* the action. `execute` receives the LLM-supplied args
 * (including `target`) and returns the value fed back to the agent.
 */
export interface ElementCapability {
  execute: (args: Record<string, unknown>) => unknown | Promise<unknown>;
}

/** Input handed to {@link AgentElementRegistry.register} by `useAgentElement`. */
export interface RegisterElementInput {
  /**
   * Preferred id (explicit `agentId` prop, else a slug derived from the
   * element's accessible label, else its role). The registry dedupes this to
   * a unique id for the element's lifetime.
   */
  baseId: string;
  /** Element kind — drives which verbs it exposes. */
  role: string;
  /** Live accessible label, read lazily so text changes are reflected. */
  getLabel: () => string;
  /** Live state snapshot (value, checked, disabled, …), read at snapshot time. */
  getState: () => unknown;
  /** Verb → action handler. Keys must be canonical verbs in `VERB_DEFS`. */
  capabilities: Record<string, ElementCapability>;
}

/** A registered element with its assigned unique id. */
export interface RegisteredElement extends RegisterElementInput {
  id: string;
}

/**
 * Element as seen by the agent via `ui_snapshot`: id, role, current label and
 * state, and the verbs it accepts. This is the inventory the agent reads to
 * discover what it can target and act on.
 */
export interface ElementSnapshot {
  id: string;
  role: string;
  label: string;
  state: unknown;
  actions: string[];
}

/**
 * In-memory registry of interactive UI elements that core appkit-ui
 * components (Button, Input, …) register on mount via `useAgentElement`.
 * One registry per `<AgentToolsProvider>`; the provider synthesizes the
 * flattened verb tools (`click`, `set_value`, …) + `ui_snapshot` from its
 * contents.
 *
 * Mirrors {@link ClientToolRegistry} in shape (Map + listener set) so the
 * provider can subscribe to both with one `useSyncExternalStore`.
 */
export class AgentElementRegistry {
  private elements = new Map<string, RegisteredElement>();
  private listeners = new Set<() => void>();

  register(input: RegisterElementInput): () => void {
    const id = this.uniqueId(input.baseId);
    const element: RegisteredElement = { ...input, id };
    this.elements.set(id, element);
    this.emitChange();
    return () => {
      // Only delete if the live entry is still this one — guards against a
      // remount-at-new-position racing the old instance's unmount cleanup.
      if (this.elements.get(id) === element) {
        this.elements.delete(id);
        this.emitChange();
      }
    };
  }

  get(id: string): RegisteredElement | undefined {
    return this.elements.get(id);
  }

  list(): RegisteredElement[] {
    return Array.from(this.elements.values());
  }

  /** Live inventory for the `ui_snapshot` tool result. */
  snapshot(): ElementSnapshot[] {
    return this.list().map((e) => ({
      id: e.id,
      role: e.role,
      label: e.getLabel(),
      state: e.getState(),
      actions: Object.keys(e.capabilities),
    }));
  }

  /**
   * Perform a verb on a target element. Errors (unknown target, unsupported
   * verb, thrown handler) surface as `{ kind: "error" }` rather than throwing
   * — the chat hook posts the outcome to `/chat/client-tool-result` either
   * way, and the string becomes the tool result the agent sees.
   */
  async dispatch(
    verb: string,
    args: Record<string, unknown>,
  ): Promise<ClientToolDispatchOutcome> {
    const target = typeof args.target === "string" ? args.target : undefined;
    if (!target) {
      return {
        kind: "error",
        error: `'${verb}' requires a string 'target' (an element id). Call ui_snapshot to list valid targets.`,
      };
    }
    const element = this.elements.get(target);
    if (!element) {
      return {
        kind: "error",
        error: `No UI element with id '${target}'. Call ui_snapshot to list current elements.`,
      };
    }
    const capability = element.capabilities[verb];
    if (!capability) {
      return {
        kind: "error",
        error: `Element '${target}' (${element.role}) does not support '${verb}'. Supported: ${Object.keys(element.capabilities).join(", ") || "none"}.`,
      };
    }
    try {
      const result = await capability.execute(args);
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

  /**
   * Cheap key capturing which elements/verbs exist right now. The catalog
   * only needs to be rebuilt when this changes (mount/unmount/id change);
   * live state (values, checked) is read at snapshot/dispatch time and does
   * not invalidate the catalog.
   */
  registrationKey(): string {
    return this.list()
      .map((e) => `${e.id}:${Object.keys(e.capabilities).sort().join(",")}`)
      .join("|");
  }

  private uniqueId(base: string): string {
    const root = base || "element";
    if (!this.elements.has(root)) return root;
    let n = 2;
    while (this.elements.has(`${root}-${n}`)) n++;
    return `${root}-${n}`;
  }

  private emitChange(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A broken consumer must not block other listeners or future
        // registrations.
      }
    }
  }
}
