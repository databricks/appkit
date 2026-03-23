import type { DevtoolsAgentProvider } from "./types";

export function createStoredProvider(
  id: string,
  label: string,
): DevtoolsAgentProvider {
  return {
    id,
    label,
    mode: "stored",
    available: true,
  };
}
