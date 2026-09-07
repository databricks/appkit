import type { AgentAdapter } from "shared";

import {
  SUPERVISOR_EXTENSION_KEY,
  type SupervisorTool,
} from "../../agents/supervisor-api";
import type { ResolvedToolEntry } from "../../core/agent/types";
import { createLogger } from "../../logging/logger";

const logger = createLogger("agents");

/**
 * Pulls the LLM-readable description off any {@link SupervisorTool} kind.
 * Used to populate the synthetic placeholder `def.description` on
 * hosted-supervisor tool-index entries.
 */
export function supervisorToolDescription(spec: SupervisorTool): string {
  switch (spec.type) {
    case "genie_space":
      return spec.genie_space.description;
    case "uc_function":
      return spec.uc_function.description;
    case "knowledge_assistant":
      return spec.knowledge_assistant.description;
    case "app":
      return spec.app.description;
    case "uc_connection":
      return spec.uc_connection.description;
  }
}

/**
 * Builds the `AgentInput.extensions` payload from a tool index, aggregating
 * the hosted-supervisor specs under {@link SUPERVISOR_EXTENSION_KEY}. Returns
 * `undefined` when there are no adapter-side hosted tools so the field stays
 * absent on the wire — adapters that don't read extensions never see it.
 */
export function buildAdapterExtensions(
  toolIndex: Map<string, ResolvedToolEntry>,
): Readonly<Record<string, unknown>> | undefined {
  const supervisorSpecs: SupervisorTool[] = [];
  for (const entry of toolIndex.values()) {
    if (entry.source === "hosted-supervisor") {
      supervisorSpecs.push(entry.spec);
    }
  }
  if (supervisorSpecs.length === 0) return undefined;
  return {
    [SUPERVISOR_EXTENSION_KEY]: { hostedTools: supervisorSpecs },
  };
}

/**
 * Compares the adapter's declared capabilities against the tool index and
 * logs a warning when the agent's tool declarations would be silently
 * dropped at runtime. Warn-not-throw: misconfiguration is loud enough to
 * notice without taking the whole app down.
 */
export function warnOnCapabilityMismatch(
  agentName: string,
  adapter: AgentAdapter,
  toolIndex: Map<string, ResolvedToolEntry>,
): void {
  const accepted = new Set(adapter.acceptsExtensions ?? []);

  const hostedSupervisorKeys: string[] = [];
  const inputToolKeys: string[] = [];
  for (const [key, entry] of toolIndex) {
    if (entry.source === "hosted-supervisor") {
      hostedSupervisorKeys.push(key);
    } else {
      inputToolKeys.push(key);
    }
  }

  if (
    hostedSupervisorKeys.length > 0 &&
    !accepted.has(SUPERVISOR_EXTENSION_KEY)
  ) {
    logger.warn(
      `Agent '${agentName}' declares hosted-supervisor tools (${hostedSupervisorKeys.join(", ")}) ` +
        "but its model adapter does not accept the 'databricks.supervisor' extension. " +
        "These tools will not reach the model. Pair them with `DatabricksAdapter.fromSupervisorApi(...)`, or remove them.",
    );
  }

  // `consumesInputTools` defaults to true. Only warn when an adapter
  // explicitly opts out (`false`) and an input tool would be silently
  // ignored.
  if (adapter.consumesInputTools === false && inputToolKeys.length > 0) {
    logger.warn(
      `Agent '${agentName}' declares function tools / sub-agents / MCP tools (${inputToolKeys.join(", ")}) ` +
        "but its model adapter does not consume input.tools (Supervisor API owns its own tool loop). " +
        "These tools will not be exposed to the model. See docs/plugins/agents.md.",
    );
  }
}
