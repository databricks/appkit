import { createClaudeCompatibleProvider } from "./claude-compatible";
import type { InspectorAgentProvider } from "./types";

export function createClaudeCodeProvider(): InspectorAgentProvider {
  return createClaudeCompatibleProvider({
    id: "claude-code",
    label: "Claude Code",
    binaryNames: ["claude"],
  });
}

export function createIsaacProvider(): InspectorAgentProvider {
  return createClaudeCompatibleProvider({
    id: "isaac",
    label: "Isaac",
    binaryNames: ["isaac"],
  });
}
