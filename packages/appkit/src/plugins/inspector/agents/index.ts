import { createClaudeCodeProvider, createIsaacProvider } from "./claude-code";
import { createCursorProvider } from "./cursor";
import { createStoredProvider } from "./stored";
import type { InspectorAgentInfo, InspectorAgentProvider } from "./types";

export type { InspectorAgentInfo, InspectorAgentMessage, InspectorAgentProvider } from "./types";

export function createAgentProviders(): InspectorAgentProvider[] {
  return [
    createClaudeCodeProvider(),
    createIsaacProvider(),
    createCursorProvider(),
    createStoredProvider("clipboard", "Copy prompt"),
  ];
}

export function getAgentInfo(providers: InspectorAgentProvider[]): InspectorAgentInfo[] {
  return providers.map(({ id, label, mode, available }) => ({
    id,
    label,
    mode,
    available,
  }));
}
