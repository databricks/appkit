import { type RefCallback, useCallback, useEffect, useRef } from "react";
import { useOptionalAgentElementRegistry } from "./agent-tools-provider";
import {
  type AgentElementRole,
  buildRoleCapabilities,
  deriveLabel,
  roleState,
  slugify,
} from "./verbs";

export interface UseAgentElementOptions {
  /** Element kind. Drives which verbs the element exposes (see `VERB_DEFS`). */
  role: AgentElementRole;
  /**
   * Explicit, stable id the agent targets. When omitted the id is derived
   * from the element's accessible label (slugified), falling back to its
   * role. Provide this when the label is ambiguous or changes.
   */
  agentId?: string;
  /** Override the accessible label used for the agent-facing id and snapshot. */
  label?: string;
}

/**
 * Make a core appkit-ui component agent-addressable. Registers the underlying
 * DOM node as an interactive element for as long as it is mounted, exposing
 * the verbs for its role (`button → click`, `input → set_value`, …). The
 * agent reaches it through the flattened verb tools by `target` id.
 *
 * Returns a ref callback to attach to the underlying DOM node. The hook is a
 * no-op (and registers nothing) when there is no `<AgentToolsProvider>`
 * ancestor, so it is safe to bake into every component unconditionally.
 *
 *   function Button({ agentId, ...props }) {
 *     const agentRef = useAgentElement({ role: "button", agentId });
 *     return <button ref={mergeRefs(props.ref, agentRef)} {...props} />;
 *   }
 */
export function useAgentElement<T extends HTMLElement>(
  options: UseAgentElementOptions,
): RefCallback<T> {
  const registry = useOptionalAgentElementRegistry();
  const nodeRef = useRef<T | null>(null);

  // Latest options in a ref so label/role changes are picked up by the lazily
  // evaluated label/state closures without re-registering on every render.
  const latest = useRef(options);
  latest.current = options;

  // Register on mount; re-register only when identity (role or explicit
  // agentId) changes. The node is set by the returned ref callback during
  // commit, before this effect runs.
  // biome-ignore lint/correctness/useExhaustiveDependencies: registry/role/agentId carry the identity that matters; label is read live
  useEffect(() => {
    if (!registry) return;
    const node = nodeRef.current;
    if (!node) return;

    const role = latest.current.role;
    const getNode = () => nodeRef.current;
    const getLabel = () =>
      latest.current.label ?? deriveLabel(node) ?? latest.current.role;
    const baseId =
      latest.current.agentId ?? slugify(getLabel()) ?? latest.current.role;

    return registry.register({
      baseId,
      role,
      getLabel,
      getState: () => roleState(role, node),
      capabilities: buildRoleCapabilities(role, getNode),
    });
  }, [registry, options.role, options.agentId]);

  return useCallback<RefCallback<T>>((node) => {
    nodeRef.current = node;
  }, []);
}
