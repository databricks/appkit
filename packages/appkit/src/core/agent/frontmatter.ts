const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Splits a `--- yaml ---\nbody` markdown string into its raw YAML block and
 * trimmed body. Returns `yaml: null` when there is no leading frontmatter
 * fence. Shared by the agent loader ({@link parseFrontmatter}) and the skill
 * parser so the fence regex lives in one place.
 */
export function splitFrontmatter(raw: string): {
  yaml: string | null;
  body: string;
} {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    return { yaml: null, body: raw.trim() };
  }
  return { yaml: match[1], body: match[2].trim() };
}
