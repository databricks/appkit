import type { AgentToolDefinition } from "shared";
import type { AgentElementRegistry } from "./element-registry";
import type { ClientToolRegistry } from "./registry";
import type { ClientToolDispatchOutcome } from "./types";
import { SNAPSHOT_TOOL, VERB_DEFS } from "./verbs";

/**
 * Route a tool call to the right executor: `ui_snapshot` → the live element
 * inventory, a verb (`click`, `set_value`, …) → the targeted element, anything
 * else → a raw `useAgentTool` tool. Shared by `useDispatchClientTool` (in-app
 * chat) and `useAgentToolChannel` (persistent channel / MCP), so both
 * initiators execute calls identically.
 */
export async function dispatchUiCall(
  name: string,
  args: Record<string, unknown>,
  tools: ClientToolRegistry,
  elements: AgentElementRegistry,
): Promise<ClientToolDispatchOutcome> {
  if (name === SNAPSHOT_TOOL) {
    return { kind: "ok", result: { elements: elements.snapshot() } };
  }
  if (name in VERB_DEFS) {
    return elements.dispatch(name, args);
  }
  return tools.dispatch(name, args);
}

/**
 * Build the per-request `uiTools` catalog from the live element registry plus
 * any raw `useAgentTool` tools. The element side is flattened by verb: one
 * tool per verb in use, with the valid `target` ids baked in as a JSON-Schema
 * enum so the model can only target elements that actually exist.
 *
 * When at least one element is registered we also emit `ui_snapshot`, the
 * discovery tool the agent calls to read each element's current label and
 * state before acting.
 *
 * Raw tools whose names collide with a synthesized tool (a verb or
 * `ui_snapshot`) are dropped — the synthesized tool wins, and those names are
 * reserved. Everything else is appended verbatim.
 */
export function synthesizeUiCatalog(
  elements: AgentElementRegistry,
  rawTools: AgentToolDefinition[],
): AgentToolDefinition[] {
  const out: AgentToolDefinition[] = [];
  const all = elements.list();

  if (all.length > 0) {
    out.push({
      name: SNAPSHOT_TOOL,
      description:
        "Return the current inventory of interactive UI elements the agent can act on — each element's id, role, accessible label, live state, and the actions it supports. Call this first to discover targets and read on-screen state before using the action tools.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    });

    // Group registered elements by the verbs they support.
    const byVerb = new Map<string, { id: string; label: string }[]>();
    for (const el of all) {
      const target = { id: el.id, label: el.getLabel() };
      for (const verb of Object.keys(el.capabilities)) {
        const list = byVerb.get(verb);
        if (list) list.push(target);
        else byVerb.set(verb, [target]);
      }
    }

    for (const [verb, targets] of byVerb) {
      const def = VERB_DEFS[verb];
      if (!def) continue;
      const optionsHint = targets
        .map((t) => (t.label ? `${t.id} (${t.label})` : t.id))
        .join("; ");
      out.push({
        name: verb,
        description: def.description,
        parameters: {
          type: "object",
          properties: {
            target: {
              type: "string",
              enum: targets.map((t) => t.id),
              description: `The id of the element to act on. Options: ${optionsHint}.`,
            },
            ...def.params,
          },
          required: ["target", ...def.required],
          additionalProperties: false,
        },
      });
    }
  }

  const reserved = new Set(out.map((t) => t.name));
  for (const tool of rawTools) {
    if (!reserved.has(tool.name)) out.push(tool);
  }
  return out;
}
