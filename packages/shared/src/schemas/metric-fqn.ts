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
