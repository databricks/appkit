import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createLogger } from "../../logging/logger";
import { isCreatedAgent } from "./create-agent";
import type { AgentDefinition } from "./types";

const logger = createLogger("agents:code-loader");

/** Where code agents live in source (a `tsx` dev run imports the `.ts`). */
export const CODE_AGENTS_SOURCE_DIR = "server/agents";
/** Compiled-output roots probed before source (tsdown emits into `dist`/`build`). */
const CODE_AGENTS_BUILT_ROOTS = ["dist", "build"];
/** Per-agent entry file, mirroring markdown's `agent.md`. */
const ENTRY_BASENAME = "agent";

interface ResolvedCodeAgentsDir {
  dir: string;
  extensions: string[];
}

/**
 * Resolves which directory to scan for code agents. Compiled output wins over
 * source unconditionally, so a bundled server never `import()`s a `.ts` (plain
 * Node can't load one): for a relative source dir the matching `dist/<name>` /
 * `build/<name>` is probed first, with the source `.ts` dir as fallback.
 * `override`: `false` disables discovery; a relative string is the source dir
 * (still built-first); an absolute string is scanned verbatim (the caller pins
 * the exact path and owns compiling it for a prod build).
 */
export function resolveCodeAgentsDir(opts: {
  cwd: string;
  override?: string | false;
  exists: (dir: string) => boolean;
}): ResolvedCodeAgentsDir | null {
  if (opts.override === false) return null;
  if (typeof opts.override === "string" && path.isAbsolute(opts.override)) {
    return { dir: opts.override, extensions: [".ts", ".tsx", ".js", ".mjs"] };
  }

  const sourceRel = opts.override ?? CODE_AGENTS_SOURCE_DIR;
  const name = path.basename(sourceRel);
  const source: ResolvedCodeAgentsDir = {
    dir: path.resolve(opts.cwd, sourceRel),
    extensions: [".ts", ".tsx"],
  };
  const built: ResolvedCodeAgentsDir[] = CODE_AGENTS_BUILT_ROOTS.map(
    (root) => ({
      dir: path.resolve(opts.cwd, root, name),
      extensions: [".js", ".mjs"],
    }),
  );

  for (const candidate of [...built, source]) {
    if (opts.exists(candidate.dir)) return candidate;
  }
  return source;
}

/**
 * The `agent.<ext>` entry file inside an agent folder, or `null` if none —
 * a markdown agent (`agent.md`) or a non-agent asset dir (`skills/`).
 */
async function findEntryFile(
  agentDir: string,
  extensions: string[],
): Promise<string | null> {
  let files: string[];
  try {
    files = await fs.readdir(agentDir);
  } catch {
    return null;
  }
  for (const ext of extensions) {
    const name = `${ENTRY_BASENAME}${ext}`;
    if (files.includes(name)) return path.join(agentDir, name);
  }
  return null;
}

/**
 * The single created agent a module exports — the default export, else the one
 * branded named export. `undefined` if none (a helper or bundler chunk); throws
 * if the entry file exports more than one (the folder name is the id).
 */
function pickAgentExport(
  mod: Record<string, unknown>,
  filePath: string,
): AgentDefinition | undefined {
  if (isCreatedAgent(mod.default)) return mod.default;

  const named = Object.entries(mod).filter(
    ([key, value]) => key !== "default" && isCreatedAgent(value),
  );
  if (named.length === 0) return undefined;
  if (named.length > 1) {
    throw new Error(
      `Agent file '${filePath}' exports ${named.length} created agents (${named
        .map(([k]) => k)
        .join(", ")}); expected exactly one. ` +
        "Export a single agent per folder (the folder name is its id).",
    );
  }
  return named[0][1] as AgentDefinition;
}

/**
 * Discovers code agents by importing each `<id>/agent.<ext>` under `dir`; the
 * agent's id is its folder name. Folders with no `agent.<ext>` (markdown
 * agents, asset dirs) are skipped. Returns `{}` when `dir` is absent.
 *
 * Imports key on the plain `file://` URL, so `reload()` picks up added/removed
 * folders but not edits to an already-imported one (that needs a restart).
 */
export async function loadCodeAgentsFromDir(
  dir: string,
  opts: { extensions: string[] },
): Promise<Record<string, AgentDefinition>> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }

  const folders = entries
    // Include symlinked agent folders; findEntryFile's readdir follows the link
    // and returns null for anything that isn't a real directory.
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => e.name)
    .sort();

  const agents: Record<string, AgentDefinition> = {};

  for (const id of folders) {
    const entryFile = await findEntryFile(path.join(dir, id), opts.extensions);
    if (!entryFile) continue;

    let mod: Record<string, unknown>;
    try {
      mod = (await import(pathToFileURL(entryFile).href)) as Record<
        string,
        unknown
      >;
    } catch (err) {
      // No TS loader for these `.ts` modules — warn once and bail rather than
      // crash boot (every folder would fail the same way).
      if (
        (err as NodeJS.ErrnoException).code === "ERR_UNKNOWN_FILE_EXTENSION"
      ) {
        logger.warn(
          "Cannot import code agents from %s under this runtime (no TypeScript loader). " +
            "A production build must compile server/agents/ to JS — check the `server/agents/*/agent.ts` entry glob in the tsdown config. Discovered no code agents.",
          dir,
        );
        return {};
      }
      throw new Error(
        `Failed to import code agent '${entryFile}': ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err instanceof Error ? err : undefined },
      );
    }

    const agent = pickAgentExport(mod, entryFile);
    if (!agent) {
      logger.debug(
        "Skipping %s — no createAgent export (not a code agent).",
        entryFile,
      );
      continue;
    }

    agents[id] = agent;
  }

  return agents;
}
