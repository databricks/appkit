import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { createLogger } from "../../../logging/logger";
import { parseSkill } from "./parse-skill";
import type { SkillDefinition, SkillSource } from "./types";

const logger = createLogger("agents:skills");

const SKILL_FILE = "SKILL.md";

/**
 * Discovers skills under `dir` — one subfolder per skill, each containing a
 * `SKILL.md`. Returns `[]` if the directory does not exist. Folders without a
 * `SKILL.md` are skipped with a warning (they may be non-skill assets).
 *
 * Reads bodies eagerly at load time; the body is only *injected* into model
 * context on demand, so reading a small markdown file at boot is cheap.
 */
export async function loadSkillsFromDir(
  dir: string,
  source: SkillSource,
): Promise<SkillDefinition[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const skillDirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const skills: SkillDefinition[] = [];
  for (const name of skillDirs) {
    const skillDir = path.join(dir, name);
    const skillFile = path.join(skillDir, SKILL_FILE);
    let raw: string;
    try {
      raw = await fs.readFile(skillFile, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        logger.warn("Skipping '%s': no %s found.", skillDir, SKILL_FILE);
        continue;
      }
      throw err;
    }

    const parsed = parseSkill(raw, skillFile);
    const files = await listResourceFiles(skillDir);
    skills.push({
      name: parsed.name,
      description: parsed.description,
      body: parsed.body,
      source,
      dir: skillDir,
      files,
      allowedTools: parsed.allowedTools,
    });
  }

  return skills;
}

/**
 * Recursively lists resource files under a skill directory, returning relative
 * posix paths and excluding the top-level `SKILL.md`. Used to build the file
 * manifest `load_skill` returns so the model knows what else it can read.
 */
async function listResourceFiles(baseDir: string): Promise<string[]> {
  const out: string[] = [];

  async function walk(current: string, rel: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(current, entry.name), childRel);
      } else if (entry.isFile()) {
        if (rel === "" && entry.name === SKILL_FILE) continue;
        out.push(childRel);
      }
    }
  }

  await walk(baseDir, "");
  return out;
}
