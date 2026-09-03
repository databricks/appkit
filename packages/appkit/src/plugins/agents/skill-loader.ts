import path from "node:path";

import { FilesConnector } from "../../connectors/files";
import {
  loadSkillsFromDir,
  parseSkill,
  readSkillResource,
  renderLoadedSkill,
  type ResolvedSkillCatalog,
  resolveSkill,
  resolveSkillCatalog,
  type SkillDefinition,
} from "../../core/agent/skills";
import type {
  AgentDefinition,
  AgentsPluginConfig,
  RegisteredAgent,
  ResolvedToolEntry,
} from "../../core/agent/types";
import { createLogger } from "../../logging/logger";
import type { WorkspaceClient } from "../../workspace-client";

const logger = createLogger("agents");

/** Loads the shared global skill pool from `<agentsDir>/skills/`. */
export async function loadGlobalSkills(
  agentsDir: string,
): Promise<SkillDefinition[]> {
  if (!agentsDir) return [];
  return loadSkillsFromDir(path.join(agentsDir, "skills"), "bundle-global");
}

/** Configured catalog-skills volume path, or null when none is set. */
function resolveSkillsVolume(config: AgentsPluginConfig): string | null {
  const configured =
    config.skillsVolume ?? process.env.DATABRICKS_VOLUME_AGENT_SKILLS;
  return configured && configured.trim() !== "" ? configured.trim() : null;
}

/**
 * Discovers catalog skills from the configured UC Volume, read as the
 * service principal at boot (and on `reload()`). Each `<volume>/<name>/`
 * folder with a `SKILL.md` becomes a `source: "volume"` skill. Best-effort:
 * a missing volume, unavailable workspace client, or a malformed individual
 * skill is logged and skipped rather than failing the whole registry build.
 *
 * `getClient` is a thunk so the workspace-client resolution (the single
 * switch point for a future OBO mode) stays with the caller and is resolved
 * lazily inside the try/catch here.
 */
export async function loadVolumeSkills(
  config: AgentsPluginConfig,
  getClient: () => WorkspaceClient,
): Promise<SkillDefinition[]> {
  const volume = resolveSkillsVolume(config);
  if (!volume) return [];

  if ((config.skillCredentialMode ?? "sp") === "obo") {
    logger.warn(
      "skillCredentialMode 'obo' is not wired yet; reading catalog skills as the service principal.",
    );
  }

  let client: WorkspaceClient;
  try {
    client = getClient();
  } catch (err) {
    logger.warn(
      "Skipping catalog skills at '%s': no workspace client available (%s).",
      volume,
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }

  const connector = new FilesConnector({ defaultVolume: volume });
  let entries: Awaited<ReturnType<FilesConnector["list"]>>;
  try {
    entries = await connector.list(client, volume);
  } catch (err) {
    logger.warn(
      "Failed to list catalog skills volume '%s': %s",
      volume,
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }

  // Read every skill concurrently — each is a network round-trip to the
  // volume, so serial reads would add up. A per-skill failure skips only
  // that skill; Promise.all preserves the (sorted) entry order.
  const loaded = await Promise.all(
    entries.map(async (entry): Promise<SkillDefinition | null> => {
      if (!entry.is_directory || !entry.name || !entry.path) return null;
      const skillDir = entry.path;
      const skillFile = `${skillDir}/SKILL.md`;
      try {
        const raw = await connector.read(client, skillFile);
        const parsed = parseSkill(raw, skillFile);
        const files = await listVolumeSkillFiles(connector, client, skillDir);
        return {
          name: parsed.name,
          description: parsed.description,
          body: parsed.body,
          source: "volume",
          dir: skillDir,
          files,
          allowedTools: parsed.allowedTools,
        };
      } catch (err) {
        logger.warn(
          "Skipping catalog skill '%s': %s",
          skillDir,
          err instanceof Error ? err.message : String(err),
        );
        return null;
      }
    }),
  );
  return loaded.filter((s): s is SkillDefinition => s !== null);
}

/** Lists a volume skill's resource files (one level, excluding SKILL.md). */
async function listVolumeSkillFiles(
  connector: FilesConnector,
  client: WorkspaceClient,
  skillDir: string,
): Promise<string[]> {
  try {
    const entries = await connector.list(client, skillDir);
    return entries
      .filter((e) => !e.is_directory && e.name && e.name !== "SKILL.md")
      .map((e) => e.name as string)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Resolves the per-agent skill catalog: loads this agent's private skills
 * (`<agentsDir>/<id>/skills/`, file-origin only), then applies visibility
 * (opt-in via `def.skills` or the resolved `autoInherit`) and collision rules
 * against the shared global pool. Returns `undefined` when nothing is visible
 * so the prompt catalog and dispatch can cheaply skip skills.
 */
export async function resolveAgentSkills(opts: {
  name: string;
  def: AgentDefinition;
  agentsDir: string;
  isFileOrigin: boolean;
  autoInherit: boolean;
  globalSkills: SkillDefinition[];
}): Promise<ResolvedSkillCatalog | undefined> {
  const perAgentSkills =
    opts.isFileOrigin && opts.agentsDir
      ? await loadSkillsFromDir(
          path.join(opts.agentsDir, opts.name, "skills"),
          "bundle-agent",
        )
      : [];

  const catalog = resolveSkillCatalog({
    agentName: opts.name,
    agentSkillNames: opts.def.skills,
    perAgentSkills,
    globalSkills: opts.globalSkills,
    autoInherit: opts.autoInherit,
  });

  return catalog.byAddress.size > 0 ? catalog : undefined;
}

/**
 * Executes the built-in `load_skill` / `read_skill_file` tools against the
 * agent's resolved skill catalog. `load_skill` returns a skill's body plus a
 * manifest of bundled files; `read_skill_file` returns the contents of one
 * of those files.
 */
export async function dispatchSkillTool(
  entry: Extract<ResolvedToolEntry, { source: "skill" }>,
  args: unknown,
  getClient: () => WorkspaceClient,
): Promise<string> {
  const obj =
    typeof args === "object" && args !== null
      ? (args as Record<string, unknown>)
      : {};
  const skillName = typeof obj.skill === "string" ? obj.skill.trim() : "";
  if (!skillName) {
    throw new Error(
      `'${entry.builtin}' requires a 'skill' argument naming the skill to use.`,
    );
  }

  const skill = resolveSkill(entry.catalog, skillName);

  if (entry.builtin === "load_skill") {
    return renderLoadedSkill(skill);
  }

  // read_skill_file
  const filePath = typeof obj.path === "string" ? obj.path.trim() : "";
  if (!filePath) {
    throw new Error("'read_skill_file' requires a 'path' argument.");
  }
  if (!skill.files.includes(filePath)) {
    throw new Error(
      `Skill '${skill.name}' has no bundled file '${filePath}'. Available: ${
        skill.files.join(", ") || "<none>"
      }.`,
    );
  }

  if (skill.source === "volume") {
    const connector = new FilesConnector({ defaultVolume: skill.dir });
    return connector.read(getClient(), `${skill.dir}/${filePath}`);
  }
  return readSkillResource(skill.dir, filePath);
}

/**
 * Renders the prompt addendum for a force-loaded skill (`/skill-name`).
 * Returns null when the agent has no catalog or the name doesn't resolve —
 * an unusable request shouldn't fail the whole turn, so it's logged and the
 * model proceeds with the catalog + `load_skill` still available.
 */
export function renderForcedSkill(
  registered: RegisteredAgent,
  name: string,
): string | null {
  if (!registered.skills) return null;
  try {
    const skill = resolveSkill(registered.skills, name);
    return `The user explicitly requested the "${skill.name}" skill for this turn. Its instructions:\n\n${renderLoadedSkill(skill)}`;
  } catch (err) {
    logger.warn(
      "Ignoring forced skill '%s': %s",
      name,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
