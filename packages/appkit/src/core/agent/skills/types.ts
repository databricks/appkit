/** Where a skill was discovered. Drives the qualified name used on collision. */
export type SkillSource = "bundle-agent" | "bundle-global" | "volume";

/**
 * A single skill: a `SKILL.md` (frontmatter `name`+`description` + Markdown
 * body) plus any bundled resource files in the same directory. The body is
 * loaded into model context on demand (via the `load_skill` tool or a forced
 * `/skill-name` invocation); only `name`+`description` are always-on in the
 * prompt catalog.
 */
export interface SkillDefinition {
  /** Frontmatter `name`. The addressable skill id. */
  name: string;
  /** Frontmatter `description`. Injected into the always-on prompt catalog. */
  description: string;
  /** Markdown body — the instructions loaded on demand. */
  body: string;
  /** Where the skill came from. */
  source: SkillSource;
  /** Absolute directory containing `SKILL.md` and any bundled resources. */
  dir: string;
  /** Relative posix paths of bundled resource files (excludes `SKILL.md`). */
  files: string[];
  /**
   * Optional advisory tool allowlist from frontmatter `allowed-tools`. Surfaced
   * as a hint in v1 — NOT enforced (loading a skill does not restrict the
   * agent's callable tools).
   */
  allowedTools?: string[];
}

/** The always-on prompt entry for a skill (what the model sees before loading). */
export interface SkillCatalogEntry {
  /** Addressable name — bare when unique, `<scope>:name` when collided. */
  name: string;
  description: string;
}

/**
 * Per-agent resolved skill catalog: visibility + collision rules applied.
 * `byAddress` maps every addressable name (bare or qualified) to its skill;
 * `ambiguous` maps a bare name shadowed by multiple sources to the qualified
 * alternatives; `catalog` is the always-on prompt list (one entry per address).
 */
export interface ResolvedSkillCatalog {
  byAddress: Map<string, SkillDefinition>;
  ambiguous: Map<string, string[]>;
  catalog: SkillCatalogEntry[];
}
