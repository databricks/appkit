/**
 * Unity Catalog object-name grammar
 * the single source of truth for metric view FQN (Fully Qualified Name).
 *
 * A metric view's `source` FQN is validated in two places that must agree:
 *
 *  1. The canonical Zod schema (`./metric-source.ts`), which composes the
 *     three-part FQN regex from {@link UC_FQN_PATTERN} for IDE/CI and the
 *     generated JSON schema (`docs/static/schemas/metric-source.schema.json`).
 *  2. The type-generator runtime (`packages/appkit/src/type-generator/mv-registry/config.ts`),
 *     which imports {@link UC_FQN_PATTERN} as a plain value to validate each
 *     dot-split segment.
 *
 *
 * A Unity Catalog object name:
 *  - cannot exceed 255 characters ({@link MAX_UC_OBJECT_NAME_LENGTH}); and
 *  - cannot contain any of these characters:
 *      - period (`.`)
 *      - space (U+0020)
 *      - forward slash (`/`)
 *      - all ASCII control characters (U+0000-U+001F)
 *      - the DELETE character (U+007F)
 *
 * Every other character is permitted in a quoted name, including non-ASCII
 * letters (the docs demonstrate Chinese/Russian/Portuguese names) and hyphens.
 *
 * @note the regex is the per-segment character set; structure (3 parts) and length are intentionally left to the callers.
 */

export const MAX_UC_OBJECT_NAME_LENGTH = 255;

/**
 * Basename of the metric-view declarations file, resolved inside a
 * `config/metric-views/` folder. Single source of truth shared by the analytics
 * runtime (`plugins/analytics/mv`), the type-generator, its Vite watcher, and
 * the `generate-types` CLI. It lives in this zod-free module (rather than the
 * canonical `metric-source.ts` schema) so the type-generator can import it
 * without pulling zod into its locked dependency graph.
 */
export const METRIC_CONFIG_FILE = "definitions.json";

/**
 * Matches a single, non-empty Unity Catalog object name as it may appear in a backtick-quoted (delimited) identifier.
 *
 * @example
 * UC_FQN_PATTERN.test("revenue_metrics"); // true
 * UC_FQN_PATTERN.test("prod-data");        // true (hyphens are UC-legal)
 * UC_FQN_PATTERN.test("cafe\u0301");       // true (non-ASCII is UC-legal)
 * UC_FQN_PATTERN.test("bad name");         // false (space is prohibited)
 * UC_FQN_PATTERN.test("a/b");              // false (slash is prohibited)
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: UC explicitly prohibits ASCII control characters in object names; this negated class encodes that rule.
export const UC_FQN_PATTERN = /^[^\x00-\x20\x7f./]+$/;

/** A metric view FQN is exactly three segments: catalog.schema.metric_view. */
const FQN_SEGMENT_COUNT = 3;

/**
 * Total predicate: is `fqn` a well-formed three-part UC metric view FQN?
 * Well-formed = exactly three non-empty, dot-separated segments, each a valid Unity Catalog object name per {@link UC_FQN_PATTERN}.
 * @example
 * isValidFqn("main.analytics.revenue");   // true
 * isValidFqn("prod-data.analytics.rev");   // true (hyphens are UC-legal)
 * isValidFqn("main.analytics");            // false (only two segments)
 */
export function isValidFqn(fqn: string): boolean {
  const segments = fqn.split(".");
  if (segments.length !== FQN_SEGMENT_COUNT) {
    return false;
  }
  return segments.every((segment) => UC_FQN_PATTERN.test(segment));
}

/**
 * Quote a dot-separated FQN for safe interpolation into a Spark/Databricks SQL
 * statement.
 *
 * Each dot-split segment is wrapped in backtick-quoted-identifier syntax. The
 * one character that can break out of a backtick-quoted identifier is the
 * backtick itself, escaped by doubling (`` ` `` → `` `` ``) — so every backtick
 * inside a segment is doubled before the segment is wrapped. Control characters
 * and newlines have no valid escape inside a quoted identifier, so a segment
 * containing one is rejected outright.
 *
 * This is a pure, standalone escaper: it is intentionally independent of FQN
 * naming validation ({@link isValidFqn}). Naming validation decides whether an
 * FQN is an acceptable metric source; this function only guarantees that
 * whatever it is handed cannot break out of the quoted identifier it produces.
 * Grammar and quoting live together here so a metric source is validated and
 * escaped against one shared source of truth.
 *
 * An ordinary identifier is unchanged apart from the wrapping backticks:
 * `catalog.schema.view` → `` `catalog`.`schema`.`view` ``.
 *
 * @param fqn - Dot-separated identifier (e.g. `catalog.schema.view`).
 * @returns The backtick-quoted, escaped identifier ready for interpolation.
 * @throws If any segment contains a control character or newline.
 */
export function quoteFqnForSql(fqn: string): string {
  return fqn.split(".").map(quoteIdentifier).join(".");
}

/**
 * The Unicode "control" category (`\p{Cc}`): C0 (incl. `\n`, `\r`, `\t`), DEL,
 * and C1 — every control character/newline. These have no valid escape inside
 * a backtick-quoted identifier, so a name containing one cannot be safely
 * quoted and is rejected.
 */
const CONTROL_OR_NEWLINE = /\p{Cc}/u;

export function isValidColumnName(name: string): boolean {
  return name.length > 0 && !CONTROL_OR_NEWLINE.test(name);
}

/**
 * Quote a single identifier (one column/measure/dimension name, or one FQN
 * segment) as a backtick-delimited identifier for safe SQL interpolation.
 *
 * @throws If `name` contains a control character or newline.
 */
export function quoteIdentifier(name: string): string {
  if (CONTROL_OR_NEWLINE.test(name)) {
    throw new Error(
      `Cannot quote identifier "${name}" for SQL: it contains a control character or newline, which has no valid escape inside a backtick-quoted identifier.`,
    );
  }
  // Double every backtick, then wrap in backticks.
  return `\`${name.replace(/`/g, "``")}\``;
}
