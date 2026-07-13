import { readdirSync, statSync } from "node:fs";
import path from "node:path";

/** An eval file found under `config/agents/<agent>/evals/`. */
export interface DiscoveredEval {
  /** Absolute path to the `*.eval.ts` file. */
  file: string;
  /** Id relative to the agent's evals dir, without `.eval.ts` (e.g. `weather/basic`). */
  id: string;
  /** The agent id (the `config/agents/<agent>` directory name). */
  agent: string;
}

/** A per-agent `evals.config.ts` found under `config/agents/<agent>/evals/`. */
export interface DiscoveredEvalConfig {
  /** Absolute path to the `evals.config.ts` file. */
  file: string;
  /** The agent id whose evals this config applies to. */
  agent: string;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** List the agent directory names under `<rootDir>/config/agents/` (empty if absent). */
function listAgents(rootDir: string): { agentsDir: string; agents: string[] } {
  const agentsDir = path.join(rootDir, "config", "agents");
  try {
    const agents = readdirSync(agentsDir).filter((n) =>
      isDir(path.join(agentsDir, n)),
    );
    return { agentsDir, agents };
  } catch {
    return { agentsDir, agents: [] };
  }
}

/** Recursively collect `*.eval.ts` files (skips `evals.config.ts`). */
function walkEvalFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (isDir(full)) {
      out.push(...walkEvalFiles(full));
    } else if (entry.endsWith(".eval.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Discover evals under `<rootDir>/config/agents/<agent>/evals/`. The agent id
 * is the directory name; the eval id is the file path relative to that evals
 * dir with `.eval.ts` stripped. Returns a stable, sorted list.
 */
export function discoverEvalFiles(rootDir: string): DiscoveredEval[] {
  const { agentsDir, agents } = listAgents(rootDir);
  const out: DiscoveredEval[] = [];

  for (const agent of agents) {
    const evalsDir = path.join(agentsDir, agent, "evals");
    if (!isDir(evalsDir)) continue;
    for (const file of walkEvalFiles(evalsDir)) {
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
 * `<rootDir>/config/agents/<agent>/evals/evals.config.ts`. Config is per-agent:
 * each agent's config applies only to that agent's evals. Agents without a
 * config file are omitted. Returns a stable, sorted list.
 */
export function discoverEvalConfigs(rootDir: string): DiscoveredEvalConfig[] {
  const { agentsDir, agents } = listAgents(rootDir);
  const out: DiscoveredEvalConfig[] = [];

  for (const agent of agents) {
    const file = path.join(agentsDir, agent, "evals", "evals.config.ts");
    if (isFile(file)) out.push({ file, agent });
  }

  return out.sort((a, b) => a.agent.localeCompare(b.agent));
}
