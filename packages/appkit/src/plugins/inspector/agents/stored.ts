import type { InspectorAgentProvider } from "./types";

export function createStoredProvider(
  id: string,
  label: string,
): InspectorAgentProvider {
  return {
    id,
    label,
    mode: "stored",
    available: true,
  };
}
