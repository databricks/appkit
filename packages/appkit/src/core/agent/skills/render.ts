import type { SkillCatalogEntry, SkillDefinition } from "./types";

/**
 * Renders the always-on skill catalog block appended to an agent's system
 * prompt. Lists each visible skill's name + description and tells the model to
 * call `load_skill` before acting on a matching task.
 */
export function renderSkillCatalog(entries: SkillCatalogEntry[]): string {
  return [
    "## Available skills",
    "When a task matches one of these skills, call the `load_skill` tool with the skill's exact name to load its full instructions before proceeding.",
    "",
    ...entries.map((e) => `- **${e.name}**: ${e.description}`),
  ].join("\n");
}

/**
 * Renders the tool-result payload returned by `load_skill`: the skill body
 * plus a manifest of bundled files (readable via `read_skill_file`) and any
 * advisory `allowed-tools` hint.
 */
export function renderLoadedSkill(skill: SkillDefinition): string {
  const parts = [`# Skill: ${skill.name}`, "", skill.body];

  if (skill.files.length > 0) {
    parts.push(
      "",
      "## Bundled files",
      "Read any of these with the `read_skill_file` tool (pass this skill's name and the file path):",
      ...skill.files.map((f) => `- ${f}`),
    );
  }

  if (skill.allowedTools && skill.allowedTools.length > 0) {
    parts.push(
      "",
      `_Suggested tools for this skill: ${skill.allowedTools.join(", ")}._`,
    );
  }

  return parts.join("\n");
}
