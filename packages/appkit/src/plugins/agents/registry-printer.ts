import pc from "picocolors";
import type { RegisteredAgent } from "../../core/agent/types";

/**
 * Pretty-prints the registered agent set during plugin setup. Decorative —
 * no behaviour change if it's skipped (e.g., from tests).
 */
export function printRegistry(
  agents: Map<string, RegisteredAgent>,
  defaultAgentName: string | null,
): void {
  if (agents.size === 0) return;
  console.log("");
  console.log(`  ${pc.bold("Agents")} ${pc.dim(`(${agents.size})`)}`);
  console.log(`  ${pc.dim("─".repeat(60))}`);
  for (const [name, reg] of agents) {
    const tools = reg.toolIndex.size;
    const marker = name === defaultAgentName ? pc.green("●") : " ";
    console.log(
      `  ${marker} ${pc.bold(name.padEnd(24))} ${pc.dim(`${tools} tools`)}`,
    );
  }
  console.log(`  ${pc.dim("─".repeat(60))}`);
  console.log("");
}
