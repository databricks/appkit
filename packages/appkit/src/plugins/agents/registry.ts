import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  loadCodeAgentsFromDir,
  resolveCodeAgentsDir,
} from "../../core/agent/load-code-agents";
import type { AgentDefinition, RegisteredAgent } from "../../core/agent/types";
import { createLogger } from "../../logging/logger";

const logger = createLogger("agents");

/**
 * Context flag recorded on the in-memory AgentDefinition to indicate whether
 * it came from markdown (file) or from user code. Drives the asymmetric
 * `autoInheritTools` default.
 */
export interface AgentSource {
  origin: "file" | "code";
}

/** True when `dir` holds at least one `<id>/agent.ts` folder. */
function hasCodeAgentSources(dir: string): boolean {
  try {
    return readdirSync(dir, { withFileTypes: true }).some((e) => {
      if (!e.isDirectory() && !e.isSymbolicLink()) return false;
      try {
        return readdirSync(path.join(dir, e.name)).includes("agent.ts");
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/**
 * Discovers code agents (see {@link resolveCodeAgentsDir} and
 * {@link loadCodeAgentsFromDir}). Warns if sources exist but nothing was
 * discovered — usually the build didn't emit the compiled agents — unless
 * the deprecated `agents({ agents })` map is carrying them instead.
 */
export async function loadCodeAgents(opts: {
  agentsDir: string;
  hasDeprecatedMap: boolean;
}): Promise<Record<string, AgentDefinition>> {
  const resolved = resolveCodeAgentsDir({
    cwd: process.cwd(),
    exists: existsSync,
  });

  const discovered = await loadCodeAgentsFromDir(resolved.dir, {
    extensions: resolved.extensions,
  });

  if (
    Object.keys(discovered).length === 0 &&
    !opts.hasDeprecatedMap &&
    hasCodeAgentSources(opts.agentsDir)
  ) {
    logger.warn(
      "Found code-agent sources in %s but discovered no code agents (scanned %s). " +
        "In a production build, ensure `<dir>/*/agent.ts` is included as tsdown entries so the compiled agents are emitted.",
      opts.agentsDir,
      resolved.dir,
    );
  }

  return discovered;
}

/**
 * Resolves the default agent. Precedence: explicit `configDefault` >
 * a code/discovered agent flagged `default: true` (stable id order) >
 * markdown `default: true` > first registered (insertion order).
 */
export function resolveDefaultAgent(
  agents: Map<string, RegisteredAgent>,
  merged: Record<string, { def: AgentDefinition; src: AgentSource }>,
  fileDefault: string | null,
  configDefault: string | undefined,
): string | null {
  if (configDefault) {
    if (!agents.has(configDefault)) {
      throw new Error(
        `defaultAgent '${configDefault}' is not registered. Available: ${Array.from(agents.keys()).join(", ")}`,
      );
    }
    return configDefault;
  }

  const codeDefault = Object.keys(merged)
    .filter((id) => merged[id].src.origin === "code" && merged[id].def.default)
    .sort()[0];
  if (codeDefault) return codeDefault;

  if (fileDefault && agents.has(fileDefault)) return fileDefault;

  return agents.keys().next().value ?? null;
}
