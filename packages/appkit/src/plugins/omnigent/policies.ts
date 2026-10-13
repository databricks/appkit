/**
 * Session modes, compiled to Omnigent session policies.
 *
 * - `auto`: no gate.
 * - `ask`: tools marked as writes pause for the user's approval, and so do
 *   Omnigent's own OS tools.
 * - `read`: writes are denied.
 *
 * Omnigent enforces these on MCP tool calls itself, whatever the harness.
 */
export type OmnigentMode = "auto" | "ask" | "read";

export const OMNIGENT_MODES: readonly OmnigentMode[] = ["auto", "ask", "read"];

/** Name prefix of the policies a mode owns, so a mode change replaces only them. */
export const MODE_POLICY_PREFIX = "appkit-mode";

interface OmnigentPolicy {
  name: string;
  type: "python";
  handler: string;
  factory_params?: Record<string, unknown>;
}

function celGate(
  writeTools: string[],
  result: "ASK" | "DENY",
  reason: string,
): string {
  if (writeTools.length === 0) return `{"result": "ALLOW"}`;
  // MCP tool names reach the policy prefixed with the server name (e.g.
  // "mcp__omnigent__app__save_note"), so match on the suffix.
  const match = writeTools
    .map((t) => `event.data.name.endsWith(${JSON.stringify(t)})`)
    .join(" || ");
  return (
    `event.type == "tool_call" && (${match}) ? ` +
    `{"result": "${result}", "reason": ${JSON.stringify(reason)}} : {"result": "ALLOW"}`
  );
}

export function modePolicies(
  mode: OmnigentMode,
  writeTools: string[],
): OmnigentPolicy[] {
  if (mode === "ask") {
    return [
      {
        name: `${MODE_POLICY_PREFIX}-ask`,
        type: "python",
        handler: "omnigent.policies.builtins.cel.cel_policy",
        factory_params: {
          expression: celGate(writeTools, "ASK", "Changes app data"),
        },
      },
      {
        name: `${MODE_POLICY_PREFIX}-os`,
        type: "python",
        handler: "omnigent.policies.builtins.safety.ask_on_os_tools",
      },
    ];
  }
  if (mode === "read") {
    return [
      {
        name: `${MODE_POLICY_PREFIX}-read`,
        type: "python",
        handler: "omnigent.policies.builtins.cel.cel_policy",
        factory_params: {
          expression: celGate(writeTools, "DENY", "Read-only session"),
        },
      },
      {
        name: `${MODE_POLICY_PREFIX}-os`,
        type: "python",
        handler: "omnigent.policies.builtins.orchestration.read_only_os",
      },
    ];
  }
  return [];
}

/** Recovers a session's mode from the names of its policies. */
export function modeFromPolicies(names: Iterable<string>): OmnigentMode {
  const set = new Set(names);
  if (set.has(`${MODE_POLICY_PREFIX}-ask`)) return "ask";
  if (set.has(`${MODE_POLICY_PREFIX}-read`)) return "read";
  return "auto";
}
