import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { agentDirNames } from "../core/agent/agent-dirs";
import { CODE_AGENTS_SOURCE_DIR } from "../core/agent/load-code-agents";

/** An eval file found under `server/agents/<agent>/evals/`. */
export interface DiscoveredEval {
  /** Absolute path to the `*.eval.ts` file. */
  file: string;
  /** Id relative to the agent's evals dir, without `.eval.ts` (e.g. `weather/basic`). */
  id: string;
  /** The agent id (the `server/agents/<agent>` directory name). */
  agent: string;
}

/** A per-agent `evals.config.ts` found under `server/agents/<agent>/evals/`. */
export interface DiscoveredEvalConfig {
  /** Absolute path to the `evals.config.ts` file. */
  file: string;
  /** The agent id whose evals this config applies to. */
  agent: string;
}

/** Recursively collect `*.eval.ts` files under `dir`. Empty when `dir` is absent. */
function evalFilesIn(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".eval.ts"))
      .map((e) => path.join(e.parentPath, e.name));
  } catch {
    return [];
  }
}

/**
 * List the agent directory names under `<rootDir>/server/agents/` (empty if the
 * dir is absent). Shared by the eval-file and eval-config discovery below.
 */
function listAgents(rootDir: string): { agentsDir: string; agents: string[] } {
  const agentsDir = path.join(rootDir, CODE_AGENTS_SOURCE_DIR);
  try {
    return {
      agentsDir,
      agents: agentDirNames(readdirSync(agentsDir, { withFileTypes: true })),
    };
  } catch {
    return { agentsDir, agents: [] };
  }
}

/**
 * Discover evals under `<rootDir>/server/agents/<agent>/evals/` — co-located
 * with each agent's `agent.{md,ts}` (same folder-per-agent layout the agents
 * plugin discovers). The agent id is the folder name; the eval id is the file
 * path relative to that evals dir with `.eval.ts` stripped. Sorted + stable.
 */
export function discoverEvalFiles(rootDir: string): DiscoveredEval[] {
  const { agentsDir, agents } = listAgents(rootDir);
  const out: DiscoveredEval[] = [];

  for (const agent of agents) {
    const evalsDir = path.join(agentsDir, agent, "evals");
    for (const file of evalFilesIn(evalsDir)) {
      const id = path
        .relative(evalsDir, file)
        .replace(/\.eval\.ts$/, "")
        .split(path.sep)
        .join("/");
      out.push({ file, id, agent });
    }
  }

  return out.sort(
    (a, b) => a.agent.localeCompare(b.agent) || a.id.localeCompare(b.id),
  );
}

/**
 * Discover the per-agent `evals.config.ts` (from {@link defineEvalConfig}) at
 * `<rootDir>/server/agents/<agent>/evals/evals.config.ts`. Config is per-agent:
 * each agent's config applies only to that agent's evals. Agents without a
 * config file are omitted. Returns a stable, sorted list.
 */
export function discoverEvalConfigs(rootDir: string): DiscoveredEvalConfig[] {
  const { agentsDir, agents } = listAgents(rootDir);
  const out: DiscoveredEvalConfig[] = [];

  for (const agent of agents) {
    const file = path.join(agentsDir, agent, "evals", "evals.config.ts");
    if (existsSync(file)) out.push({ file, agent });
  }

  return out.sort((a, b) => a.agent.localeCompare(b.agent));
}
