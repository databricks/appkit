import { createClaudeCompatibleProvider } from "./claude-compatible";
import type { DevtoolsAgentProvider } from "./types";

export function createClaudeCodeProvider(): DevtoolsAgentProvider {
  return createClaudeCompatibleProvider({
    id: "claude-code",
    label: "Claude Code",
    binaryNames: ["claude"],
  });
}

export function createIsaacProvider(): DevtoolsAgentProvider {
  return createClaudeCompatibleProvider({
    id: "isaac",
    label: "Isaac",
    binaryNames: ["isaac"],
  });
}
