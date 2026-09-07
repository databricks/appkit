import type { ToolAnnotations } from "shared";

/**
 * Decide whether a tool call must traverse the approval gate. Honours both
 * the modern `effect` field (mutating values: write / update / destructive)
 * and the legacy `destructive: true` boolean. The contract is documented on
 * `ToolAnnotations.effect` in shared/agent.ts.
 *
 * Without this, a tool authored only with `effect: "destructive"` (the
 * preferred API) bypassed the gate entirely.
 */
export function requiresApproval(
  annotations: ToolAnnotations | undefined,
): boolean {
  if (!annotations) return false;
  if (annotations.destructive === true) return true;
  switch (annotations.effect) {
    case "write":
    case "update":
    case "destructive":
      return true;
    case "read":
    case undefined:
      return false;
    default: {
      const _exhaustive: never = annotations.effect;
      return false;
    }
  }
}
