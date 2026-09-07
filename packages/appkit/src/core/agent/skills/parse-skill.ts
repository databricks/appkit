import yaml from "js-yaml";

import { createLogger } from "../../../logging/logger";
import { splitFrontmatter } from "../frontmatter";

const logger = createLogger("agents:skills");

/**
 * Frontmatter keys AppKit recognizes. Compatibility-first: this is the
 * Anthropic `SKILL.md` surface (`name`, `description`, `license`,
 * `allowed-tools`, `metadata`) so skills authored for Claude Code / Cursor
 * load unmodified. Unknown keys warn rather than error.
 */
const KNOWN_SKILL_KEYS = new Set([
  "name",
  "description",
  "license",
  "allowed-tools",
  "metadata",
]);

/** Addressable-name guard: no `:` (qualified-name separator), no `/`, no whitespace. */
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

interface ParsedSkill {
  name: string;
  description: string;
  body: string;
  allowedTools?: string[];
}

/**
 * Parses a `SKILL.md` string. Requires non-empty `name` + `description`;
 * validates the name is addressable; warns on unknown frontmatter keys.
 */
export function parseSkill(raw: string, sourcePath: string): ParsedSkill {
  const { yaml: yamlBlock, body } = splitFrontmatter(raw);
  if (yamlBlock === null) {
    throw new Error(
      `Skill file ${sourcePath} has no YAML frontmatter (expected '--- name/description ---').`,
    );
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(yamlBlock);
  } catch (err) {
    throw new Error(
      `Invalid YAML frontmatter in ${sourcePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Skill frontmatter in ${sourcePath} must be a YAML object.`,
    );
  }

  const data = parsed as Record<string, unknown>;
  const { name, description } = data;

  if (typeof name !== "string" || name.trim() === "") {
    throw new Error(
      `Skill ${sourcePath} is missing a non-empty 'name' in frontmatter.`,
    );
  }
  const trimmedName = name.trim();
  if (!NAME_RE.test(trimmedName)) {
    throw new Error(
      `Skill '${trimmedName}' (${sourcePath}) has an invalid name: use letters, digits, '.', '_', '-' only (no ':', '/', or spaces).`,
    );
  }
  if (typeof description !== "string" || description.trim() === "") {
    throw new Error(
      `Skill '${trimmedName}' (${sourcePath}) is missing a non-empty 'description' in frontmatter.`,
    );
  }

  for (const key of Object.keys(data)) {
    if (!KNOWN_SKILL_KEYS.has(key)) {
      logger.warn(
        "Ignoring unknown SKILL.md frontmatter key '%s' in %s",
        key,
        sourcePath,
      );
    }
  }

  return {
    name: trimmedName,
    description: description.trim(),
    body,
    allowedTools: parseAllowedTools(
      data["allowed-tools"],
      trimmedName,
      sourcePath,
    ),
  };
}

/**
 * Accepts `allowed-tools` as a string[] or a comma-separated string (both
 * appear in the wild). Returns `undefined` when absent/empty/malformed.
 */
function parseAllowedTools(
  value: unknown,
  skillName: string,
  sourcePath: string,
): string[] | undefined {
  if (value === undefined) return undefined;

  let list: string[];
  if (typeof value === "string") {
    list = value.split(",");
  } else if (
    Array.isArray(value) &&
    value.every((v) => typeof v === "string")
  ) {
    list = value as string[];
  } else {
    logger.warn(
      "Ignoring 'allowed-tools' for skill '%s' in %s: expected string or string[]",
      skillName,
      sourcePath,
    );
    return undefined;
  }

  const cleaned = list.map((s) => s.trim()).filter((s) => s.length > 0);
  return cleaned.length > 0 ? cleaned : undefined;
}
