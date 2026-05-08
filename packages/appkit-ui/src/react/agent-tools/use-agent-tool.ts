import { useEffect, useRef } from "react";
import { useClientToolRegistry } from "./agent-tools-provider";
import type { UseAgentToolConfig } from "./types";

/**
 * Register a UI tool the agent can invoke for as long as this component is
 * mounted. The tool joins the chat request's `uiTools` catalog on the next
 * `POST /chat`, and a matching `appkit.client_tool_call` SSE event from the
 * server is dispatched against the same `execute` callback that was last
 * registered.
 *
 * Best-effort identity: if the same hook re-runs with a fresh `execute`
 * closure (typical, since callbacks change every render), the registry
 * stores the latest reference without unregistering. The tool definition
 * itself (`name`, `description`, `parameters`, `annotations`) is held in
 * a ref so changes to those fields are picked up too.
 *
 *   useAgentTool({
 *     name: "counter.increment",
 *     description: "Increment the counter by 1",
 *     parameters: { type: "object", properties: {} },
 *     execute: async () => {
 *       setCount((c) => c + 1);
 *       return { ok: true };
 *     },
 *   });
 *
 * Must be called inside an `<AgentToolsProvider>`.
 */
export function useAgentTool(config: UseAgentToolConfig): void {
  const registry = useClientToolRegistry();

  // Keep the latest config in a ref so the registered closure always sees
  // up-to-date `execute` / `parameters` / `annotations` without forcing
  // re-registration on every render. Re-registration would otherwise
  // momentarily drop the tool from the catalog and race with an in-flight
  // chat request that just snapshotted it.
  const latest = useRef(config);
  latest.current = config;

  // Re-register only when the tool's identity (its `name`) changes;
  // changes to description/parameters/execute are picked up via the
  // `latest` ref above without flapping the registry. Biome can't see
  // through the ref so we suppress its dep check here.
  // biome-ignore lint/correctness/useExhaustiveDependencies: registry+name carry the identity that matters
  useEffect(() => {
    const name = config.name;
    const unregister = registry.register({
      def: {
        name,
        description: latest.current.description,
        parameters: latest.current.parameters,
        annotations: latest.current.annotations,
      },
      execute: (args) => latest.current.execute(args),
    });
    return unregister;
  }, [registry, config.name]);
}
