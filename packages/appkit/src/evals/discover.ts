import { type Dirent, readdirSync } from "node:fs";
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
 * Discover evals under `<rootDir>/server/agents/<agent>/evals/` — co-located
 * with each agent's `agent.{md,ts}` (same folder-per-agent layout the agents
 * plugin discovers). The agent id is the folder name; the eval id is the file
 * path relative to that evals dir with `.eval.ts` stripped. Sorted + stable.
 */
export function discoverEvalFiles(rootDir: string): DiscoveredEval[] {
  const agentsDir = path.join(rootDir, CODE_AGENTS_SOURCE_DIR);
  const out: DiscoveredEval[] = [];

  let entries: Dirent[];
  try {
    entries = readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const agent of agentDirNames(entries)) {
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
