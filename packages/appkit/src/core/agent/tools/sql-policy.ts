/**
 * Conservative SQL classifier used by agent-facing query tools to enforce
 * `readOnly: true` annotations at execution time.
 *
 * Why a hand-rolled tokenizer rather than `node-sql-parser` or `pgsql-parser`:
 *
 * - `node-sql-parser`'s Hive/Spark dialect coverage rejects common Databricks
 *   SQL patterns (three-part `catalog.schema.table` names, `SHOW TABLES IN`,
 *   `DESCRIBE EXTENDED`, `EXPLAIN`) that must be allowed by a read-only
 *   classifier. Its PostgreSQL grammar rejects `SHOW`/`DESCRIBE` too.
 * - `pgsql-parser` (libpg_query) is a native binding and fails to install
 *   cleanly on every Databricks App runtime we care about.
 *
 * We don't need to fully parse SQL — we only need to decide whether every
 * statement in the batch starts with a read-only keyword. A small tokenizer
 * that correctly strips strings, identifiers, and comments is enough and
 * costs no extra dependencies.
 *
 * What this classifier guarantees (when it returns `readOnly: true`):
 *
 * - Every semicolon-separated statement outside a string, identifier, or
 *   comment begins with `SELECT`, `WITH`, `SHOW`, `EXPLAIN`, `DESCRIBE`, or
 *   `DESC`.
 * - `SELECT 1; DROP TABLE x` is rejected (stacked write detected).
 * - `SELECT 'value; DROP TABLE x'` passes (literal inside a string).
 * - `-- DROP TABLE x\nSELECT 1` passes (comment stripped).
 * - `SELECT 1 <block-comment ; DROP block-comment>` passes (comment stripped).
 *
 * What this classifier does NOT guarantee:
 *
 * - A `SELECT` statement may still have side effects via function calls
 *   (`SELECT pg_advisory_lock(...)`, `SELECT lo_import('/etc/passwd')`, CTEs
 *   with DML in Postgres 9.1+). Callers that need stronger guarantees should
 *   combine this check with a runtime mechanism: for PostgreSQL, execute the
 *   statement inside a dedicated client's `BEGIN READ ONLY … ROLLBACK`
 *   transaction (see `LakebasePlugin.runReadOnlyStatement`). A batched
 *   `pool.query("BEGIN READ ONLY; <stmt>; ROLLBACK")` cannot be used because
 *   the Postgres Extended Query protocol rejects multi-statement prepared
 *   queries, which silently breaks parameterized SQL.
 */

const READ_ONLY_KEYWORDS = new Set([
  "SELECT",
  "WITH",
  "SHOW",
  "EXPLAIN",
  "DESCRIBE",
  "DESC",
]);

type SqlReadOnlyResult =
  | { readOnly: true; statements: number }
  | { readOnly: false; reason: string };

/**
 * Classify a SQL string as read-only or not. See module docstring for the
 * precise guarantee this offers.
 */
export function classifyReadOnly(sql: string): SqlReadOnlyResult {
  const strip = stripCommentsAndQuoted(sql);
  if (strip.unterminated) {
    return {
      readOnly: false,
      reason: `SQL has an unterminated ${strip.unterminated} literal`,
    };
  }
  const statements = splitStatements(strip.cleaned);

  if (statements.length === 0) {
    return {
      readOnly: false,
      reason: "SQL is empty or contains only comments",
    };
  }

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    const firstWord = firstKeyword(stmt);
    if (!firstWord) {
      return {
        readOnly: false,
        reason: `statement ${i + 1} of ${statements.length} is empty`,
      };
    }
    if (!READ_ONLY_KEYWORDS.has(firstWord.toUpperCase())) {
      return {
        readOnly: false,
        reason: `statement starts with '${firstWord}'; only SELECT, WITH, SHOW, EXPLAIN, DESCRIBE, DESC are allowed in read-only mode`,
      };
    }
  }

  return { readOnly: true, statements: statements.length };
}

/**
 * Assert `sql` is read-only or throw {@link ReadOnlySqlViolation}. Suitable
 * for calling from agent-tool handlers where the thrown string surfaces back
 * to the LLM as the tool's error output.
 */
export function assertReadOnlySql(sql: string): void {
  const result = classifyReadOnly(sql);
  if (!result.readOnly) {
    throw new ReadOnlySqlViolation(result.reason);
  }
}

export class ReadOnlySqlViolation extends Error {
  constructor(reason: string) {
    super(`SQL read-only policy violation: ${reason}`);
    this.name = "ReadOnlySqlViolation";
  }
}

// ---------------------------------------------------------------------------
// Tokenizer helpers
// ---------------------------------------------------------------------------

/**
 * Walk `sql` character-by-character and replace every string literal,
 * identifier quote, and comment body with a single space of equivalent
 * length. Leaves structural tokens (semicolons, whitespace, identifiers,
 * operators) in place.
 *
 * Handles:
 * - `-- line comments` through end-of-line
 * - SQL block comments (slash-star ... star-slash) with correct nesting (PostgreSQL)
 * - `'single-quoted strings'` with `''` escape
 * - `"double-quoted identifiers"` with `""` escape (ANSI)
 * - `` `backtick identifiers` `` (Databricks)
 * - `$tag$dollar quoted$tag$` strings (PostgreSQL)
 * - `E'escape-style'` strings (PostgreSQL)
 */
type StripResult = {
  cleaned: string;
  /** Non-null if tokenization ended inside an unterminated literal or comment. */
  unterminated:
    | null
    | "string"
    | "identifier"
    | "block comment"
    | "dollar-quoted string";
};

function stripCommentsAndQuoted(sql: string): StripResult {
  const out: string[] = [];
  let i = 0;
  const n = sql.length;
  let unterminated: StripResult["unterminated"] = null;

  while (i < n) {
    const ch = sql[i];
    const next = i + 1 < n ? sql[i + 1] : "";

    if (ch === "-" && next === "-") {
      out.push("  ");
      i += 2;
      while (i < n && sql[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }

    if (ch === "/" && next === "*") {
      out.push("  ");
      i += 2;
      let depth = 1;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          out.push("  ");
          i += 2;
          depth++;
          continue;
        }
        if (sql[i] === "*" && sql[i + 1] === "/") {
          out.push("  ");
          i += 2;
          depth--;
          continue;
        }
        out.push(sql[i] === "\n" ? "\n" : " ");
        i++;
      }
      if (depth > 0) {
        unterminated = "block comment";
      }
      continue;
    }

    if (
      ch === "'" ||
      (ch === "E" && next === "'") ||
      (ch === "e" && next === "'")
    ) {
      if (ch === "E" || ch === "e") {
        out.push(" ");
        i++;
      }
      out.push(" ");
      i++;
      let closed = false;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          out.push("  ");
          i += 2;
          continue;
        }
        if (sql[i] === "\\" && sql[i + 1]) {
          out.push("  ");
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          out.push(" ");
          i++;
          closed = true;
          break;
        }
        out.push(sql[i] === "\n" ? "\n" : " ");
        i++;
      }
      if (!closed) unterminated = "string";
      continue;
    }

    if (ch === '"') {
      out.push(" ");
      i++;
      let closed = false;
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          out.push("  ");
          i += 2;
          continue;
        }
        if (sql[i] === '"') {
          out.push(" ");
          i++;
          closed = true;
          break;
        }
        out.push(sql[i] === "\n" ? "\n" : " ");
        i++;
      }
      if (!closed) unterminated = "identifier";
      continue;
    }

    if (ch === "`") {
      out.push(" ");
      i++;
      let closed = false;
      while (i < n) {
        if (sql[i] === "`" && sql[i + 1] === "`") {
          out.push("  ");
          i += 2;
          continue;
        }
        if (sql[i] === "`") {
          out.push(" ");
          i++;
          closed = true;
          break;
        }
        out.push(sql[i] === "\n" ? "\n" : " ");
        i++;
      }
      if (!closed) unterminated = "identifier";
      continue;
    }

    if (ch === "$") {
      const tagMatch = sql.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (tagMatch) {
        const tag = tagMatch[0];
        out.push(" ".repeat(tag.length));
        i += tag.length;
        const closeIdx = sql.indexOf(tag, i);
        if (closeIdx === -1) {
          while (i < n) {
            out.push(sql[i] === "\n" ? "\n" : " ");
            i++;
          }
          unterminated = "dollar-quoted string";
        } else {
          while (i < closeIdx) {
            out.push(sql[i] === "\n" ? "\n" : " ");
            i++;
          }
          out.push(" ".repeat(tag.length));
          i += tag.length;
        }
        continue;
      }
    }

    out.push(ch);
    i++;
  }

  return { cleaned: out.join(""), unterminated };
}

/** Split on unquoted `;`, trim, drop empty segments. */
function splitStatements(cleanedSql: string): string[] {
  return cleanedSql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Return the first bareword keyword of a statement, or null if empty. */
function firstKeyword(stmt: string): string | null {
  const match = stmt.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)/);
  return match ? match[1] : null;
}
