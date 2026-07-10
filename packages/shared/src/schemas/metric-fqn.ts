/**
 * Unity Catalog object-name grammar - the single source of truth for metric
 * view FQN naming validation.
 *
 * This module is deliberately **zod-free**. A metric view's `source` FQN is
 * validated in two places that must agree:
 *
 *  1. The canonical Zod schema (`./metric-source.ts`), which composes the
 *     three-part FQN regex from {@link UC_FQN_PATTERN} for IDE/CI and the
 *     generated JSON schema (`docs/static/schemas/metric-source.schema.json`).
 *  2. The type-generator runtime (`packages/appkit/src/type-generator/mv-registry/config.ts`),
 *     which imports {@link UC_FQN_PATTERN} as a plain value to validate each
 *     dot-split segment.
 *
 * The type-generator's runtime path must NOT pull the shared Zod schema package
 * in (locked dependency-graph ruling - see the comment in
 * `packages/appkit/src/type-generator/cache.ts`). Keeping the pattern in this
 * zod-free module lets the runtime import the regex without dragging zod into
 * its bundle, while still single-sourcing the grammar.
 *
 * -- UC delimited (quoted) object-name rules ------------------------------
 * The metric view FQN is always backtick-quoted before interpolation into SQL
 * (see `quoteFqnForSql` in the type-generator), so the **delimited identifier**
 * grammar is the one that applies - not the narrower unquoted-identifier rule.
 *
 * Per the Databricks SQL names reference, a Unity Catalog object name:
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
 * This is intentionally broader than the old hand-rolled allowlist
 * (`[a-zA-Z0-9_-]`), which was flagged in PR #433 review (pkosiec: "more
 * restrictive than UC"): the goal is to accept what UC accepts as a quoted
 * name and reject only what UC rejects.
 *
 * Verified against the Databricks docs on 2026-06-19:
 *   https://docs.databricks.com/aws/en/sql/language-manual/sql-ref-names
 * (the link cited in the PR #433 review). If the published rules change,
 * re-confirm against that page.
 *
 * @note The period is excluded here because it is the FQN segment separator -
 * a name containing a literal dot cannot be expressed in the dotted `source`
 * string at all. The dotted-source arity (exactly three segments) and the
 * 255-char-per-segment cap are enforced structurally by the callers; this
 * pattern only encodes the per-segment allowed character set.
 */

/**
 * Maximum length, in characters, of a single Unity Catalog object name
 * (catalog, schema, or metric view). UC rejects names longer than this.
 */
export const MAX_UC_OBJECT_NAME_LENGTH = 255;

/**
 * Matches a single, non-empty Unity Catalog object name as it may appear in a
 * backtick-quoted (delimited) identifier - one segment of a metric view FQN.
 *
 * Accepts any non-empty run of characters EXCEPT the UC-prohibited set:
 * period, space, forward slash, ASCII control characters (U+0000-U+001F), and
 * DELETE (U+007F). Length is NOT bounded here - callers enforce
 * {@link MAX_UC_OBJECT_NAME_LENGTH} separately so they can emit a precise
 * "segment too long" message distinct from a charset violation.
 *
 * The negated character class encodes the prohibited set as one contiguous
 * range plus singletons: U+0000-U+0020 (every ASCII control character plus the
 * space, which sits at U+0020 immediately after the control range), U+007F
 * (DELETE), `.` (period - also the FQN segment separator), and `/` (slash).
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
 *
 * Well-formed = exactly three non-empty, dot-separated segments, each a valid
 * Unity Catalog object name per {@link UC_FQN_PATTERN}. This is the shared,
 * zod-free grammar check reused by every layer that must agree on FQN shape:
 * the type-generator's config resolver and describe seam, and the analytics
 * runtime's SQL builder. It is the boolean sibling of the composed
 * `UC_THREE_PART_FQN_PATTERN` regex in `./metric-source.ts` (which stays a
 * regex so zod can emit a JSON-schema `pattern`); both derive their per-segment
 * charset from {@link UC_FQN_PATTERN}, so they cannot diverge.
 *
 * @note Segment length ({@link MAX_UC_OBJECT_NAME_LENGTH}) is NOT checked here —
 * an over-long but otherwise legal name is still "valid shape". Callers that
 * care about the length cap enforce it separately with their own message.
 *
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

/**
 * Is `name` a column/measure/dimension identifier that {@link quoteIdentifier}
 * can safely escape? True for any non-empty string free of control characters
 * and newlines.
 *
 * This is the **column-identifier** grammar — deliberately broader than the
 * FQN-segment grammar ({@link UC_FQN_PATTERN}, which also forbids `.` and `/`
 * because they are FQN structural characters). A metric view's measure or
 * dimension is a single *delimited* column identifier: once backtick-quoted it
 * may legally contain dots, slashes, spaces, hyphens, and non-ASCII — anything
 * but a control character. The type-generator emits DESCRIBE column names
 * verbatim into the generated `measureKeys`/`dimensionKeys` unions, so the
 * runtime must accept exactly what can be safely quoted, or a generated name
 * would typecheck but fail at runtime.
 */
export function isValidColumnName(name: string): boolean {
  return name.length > 0 && !CONTROL_OR_NEWLINE.test(name);
}

/**
 * Quote a SINGLE identifier (one column/measure/dimension name, or one FQN
 * segment) as a backtick-delimited identifier for safe SQL interpolation.
 *
 * Unlike {@link quoteFqnForSql}, this does NOT split on `.` — the whole input
 * is one identifier, so a column literally named `net.revenue` becomes
 * `` `net.revenue` `` (one identifier), not `` `net`.`revenue` `` (two). The
 * backtick — the only break-out character — is doubled; control characters and
 * newlines have no valid escape and are rejected.
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
