/**
 * Spans where `:name` isn't a parameter: '...' and "..." literals, `...`
 * identifiers and `--` comments (not block comments). The first branch to
 * match wins, so `"HH:mm'T'"` is one span.
 */
const PROTECTED_RANGE_RE =
  /'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*"|`(?:[^`]|``)*`|--[^\n]*/g;

/** Start/end offsets of every span in {@link PROTECTED_RANGE_RE}. */
export function getProtectedRanges(sql: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const m of sql.matchAll(PROTECTED_RANGE_RE)) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

export function isInsideProtectedRange(
  offset: number,
  ranges: Array<[number, number]>,
): boolean {
  return ranges.some(([start, end]) => offset >= start && offset < end);
}

/**
 * Names of the `:name` parameters in a SQL statement, ignoring `::` casts and
 * anything inside string literals, quoted identifiers and comments.
 */
export function extractParameters(
  sql: string,
  ranges?: Array<[number, number]>,
): string[] {
  const protectedRanges = ranges ?? getProtectedRanges(sql);
  const params = new Set<string>();
  for (const match of sql.matchAll(/(?<!:):([a-zA-Z_]\w*)/g)) {
    if (!isInsideProtectedRange(match.index, protectedRanges)) {
      params.add(match[1]);
    }
  }
  return Array.from(params);
}
