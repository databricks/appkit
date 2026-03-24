import type { DevtoolsAgentProvider } from "./types";

export function createChannelProvider(
  id: string,
  label: string,
): DevtoolsAgentProvider {
  return {
    id,
    label,
    mode: "channel",
    available: true,
  };
}
