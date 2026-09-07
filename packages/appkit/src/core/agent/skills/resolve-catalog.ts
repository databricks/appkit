import { createLogger } from "../../../logging/logger";
import type {
  ResolvedSkillCatalog,
  SkillCatalogEntry,
  SkillDefinition,
  SkillSource,
} from "./types";

const logger = createLogger("agents:skills");

/** Qualified-name scope prefix per source, used only on cross-source collision. */
const SCOPE_BY_SOURCE: Record<SkillSource, string> = {
  "bundle-agent": "agent",
  "bundle-global": "bundle",
  volume: "volume",
};

interface ResolveCatalogInput {
  agentName: string;
  /** The agent's `skills:` frontmatter — opt-in selection from the global pool. */
  agentSkillNames?: string[];
  /** Skills private to this agent (`<id>/skills/`), always visible. */
  perAgentSkills: SkillDefinition[];
  /** Shared pool (bundle-global + volume), visible only when opted in or inherited. */
  globalSkills: SkillDefinition[];
  /** When true, every global skill is visible without an explicit `skills:` list. */
  autoInherit: boolean;
}

/**
 * Applies visibility (per-agent auto; global opt-in or auto-inherit) then
 * collision handling: a unique name is addressable bare; a name provided by
 * multiple sources becomes `<scope>:name` per source and the bare name is
 * marked ambiguous (addressing it errors with the alternatives). Two skills
 * with the same name from the *same* source is a fatal config error.
 */
export function resolveSkillCatalog(
  input: ResolveCatalogInput,
): ResolvedSkillCatalog {
  const {
    agentName,
    agentSkillNames,
    perAgentSkills,
    globalSkills,
    autoInherit,
  } = input;

  const visible: SkillDefinition[] = [...perAgentSkills];
  if (autoInherit) {
    visible.push(...globalSkills);
  } else if (agentSkillNames && agentSkillNames.length > 0) {
    const wanted = new Set(agentSkillNames);
    for (const skill of globalSkills) {
      if (wanted.has(skill.name)) visible.push(skill);
    }
    const localNames = new Set(perAgentSkills.map((s) => s.name));
    const globalNames = new Set(globalSkills.map((s) => s.name));
    for (const want of agentSkillNames) {
      if (!globalNames.has(want) && !localNames.has(want)) {
        logger.warn(
          "Agent '%s' lists skill '%s' in 'skills:', but no global or per-agent skill with that name exists.",
          agentName,
          want,
        );
      }
    }
  }

  const byName = new Map<string, SkillDefinition[]>();
  for (const skill of visible) {
    const group = byName.get(skill.name) ?? [];
    group.push(skill);
    byName.set(skill.name, group);
  }

  const byAddress = new Map<string, SkillDefinition>();
  const ambiguous = new Map<string, string[]>();

  for (const [name, group] of byName) {
    if (group.length === 1) {
      byAddress.set(name, group[0]);
      continue;
    }

    const alternatives: string[] = [];
    for (const skill of group) {
      const qualified = `${SCOPE_BY_SOURCE[skill.source]}:${name}`;
      const existing = byAddress.get(qualified);
      if (existing) {
        throw new Error(
          `Agent '${agentName}': two '${skill.source}' skills are both named '${name}' ` +
            `(${existing.dir} and ${skill.dir}). Skill names must be unique within a source.`,
        );
      }
      byAddress.set(qualified, skill);
      alternatives.push(qualified);
    }
    alternatives.sort();
    ambiguous.set(name, alternatives);
    logger.warn(
      "Agent '%s': skill name '%s' is provided by multiple sources; address it as %s.",
      agentName,
      name,
      alternatives.join(" or "),
    );
  }

  const catalog: SkillCatalogEntry[] = [...byAddress.entries()]
    .map(([address, skill]) => ({
      name: address,
      description: skill.description,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { byAddress, ambiguous, catalog };
}

/**
 * Resolves a requested skill name (bare or qualified) against a catalog.
 * Throws a helpful error on ambiguous or unknown names.
 */
export function resolveSkill(
  catalog: ResolvedSkillCatalog,
  requested: string,
): SkillDefinition {
  const direct = catalog.byAddress.get(requested);
  if (direct) return direct;

  const alternatives = catalog.ambiguous.get(requested);
  if (alternatives) {
    throw new Error(
      `Skill '${requested}' is ambiguous; specify one of: ${alternatives.join(", ")}.`,
    );
  }

  const available = [...catalog.byAddress.keys()].sort().join(", ") || "<none>";
  throw new Error(`Unknown skill '${requested}'. Available: ${available}.`);
}
