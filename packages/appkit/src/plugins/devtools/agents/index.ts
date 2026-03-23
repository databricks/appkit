import { createClaudeCodeProvider, createIsaacProvider } from "./claude-code";
import { createCursorProvider } from "./cursor";
import { createStoredProvider } from "./stored";
import type { DevtoolsAgentInfo, DevtoolsAgentProvider } from "./types";

export type { DevtoolsAgentInfo, DevtoolsAgentMessage, DevtoolsAgentProvider } from "./types";

export function createAgentProviders(): DevtoolsAgentProvider[] {
  return [
    createClaudeCodeProvider(),
    createIsaacProvider(),
    createCursorProvider(),
    createStoredProvider("clipboard", "Copy prompt"),
  ];
}

export function getAgentInfo(providers: DevtoolsAgentProvider[]): DevtoolsAgentInfo[] {
  return providers.map(({ id, label, mode, available }) => ({
    id,
    label,
    mode,
    available,
  }));
}
