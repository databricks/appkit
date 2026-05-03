import type { IntrospectedTable, IntrospectionResult } from "./types";

/** Severity of a drift entry. */
export type DriftSeverity = "info" | "warn" | "error";

/** A single drift entry. */
export interface DriftEntry {
  /** The severity of the drift entry. */
  severity: DriftSeverity;
  /** The kind of drift entry. */
  kind: "live-only" | "schema-only" | "type-mismatch";
  /** The message of the drift entry. */
  message: string;
}

/** A report of drift entries. */
export interface DriftReport {
  /** Whether there is any drift. */
  hasDrift: boolean;
  /** The entries of the drift report. */
  entries: DriftEntry[];
}

/** Diff two introspections and return a report of drift entries. */
export function diffIntrospections(
  live: IntrospectionResult,
  declared: IntrospectionResult,
): DriftReport {
  const entries: DriftEntry[] = [];
  const liveByKey = new Map(live.tables.map((t) => [tableKey(t), t]));
  const declaredByKey = new Map(declared.tables.map((t) => [tableKey(t), t]));

  for (const [key, liveTable] of liveByKey) {
    const declaredTable = declaredByKey.get(key);
    if (!declaredTable) {
      entries.push({
        severity: "warn",
        kind: "live-only",
        message: `table ${key} (exists in db, missing in schema.ts)`,
      });
      continue;
    }
    diffColumns(key, liveTable, declaredTable, entries);
  }

  for (const [key] of declaredByKey) {
    if (!liveByKey.has(key)) {
      entries.push({
        severity: "warn",
        kind: "schema-only",
        message: `table ${key} (in schema.ts, missing in db)`,
      });
    }
  }

  return { hasDrift: entries.length > 0, entries };
}

/** Diff two tables and return a report of drift entries. */
function diffColumns(
  key: string,
  live: IntrospectedTable,
  declared: IntrospectedTable,
  entries: DriftEntry[],
): void {
  const liveCols = new Map(live.columns.map((c) => [c.name, c]));
  const declaredCols = new Map(declared.columns.map((c) => [c.name, c]));

  for (const [name, liveCol] of liveCols) {
    const declaredCol = declaredCols.get(name);
    if (!declaredCol) {
      entries.push({
        severity: "warn",
        kind: "live-only",
        message: `column ${key}.${name} (in db, missing in schema.ts)`,
      });
      continue;
    }

    if (liveCol.pgType !== declaredCol.pgType) {
      entries.push({
        severity: "warn",
        kind: "type-mismatch",
        message: `column ${key}.${name} (${declaredCol.pgType} declared, ${liveCol.pgType} in db)`,
      });
    }
    diffColumnMetadata(key, name, liveCol, declaredCol, entries);
  }

  for (const [name] of declaredCols) {
    if (!liveCols.has(name)) {
      entries.push({
        severity: "warn",
        kind: "schema-only",
        message: `column ${key}.${name} (in schema.ts, missing in db)`,
      });
    }
  }
}

/** Get the key of a table. */
function tableKey(table: Pick<IntrospectedTable, "schema" | "name">): string {
  return `${table.schema}.${table.name}`;
}

/**
 * Compares the column contract beyond the raw Postgres type.
 *
 * Runtime writes and migrations depend on nullability, defaults, keys,
 * generated columns, and FK actions, so drift detection must compare the
 * metadata captured by introspection instead of stopping at `pgType`.
 *
 * Server-generated columns get special treatment: when both sides agree the
 * column is server-generated, we skip `hasDefault` and `defaultExpression`
 * comparisons because the live DB stores the literal `nextval(...)` /
 * `GENERATED AS IDENTITY` expression while the schema models the same fact
 * as `serverGenerated: true` metadata. Comparing them would produce noise on
 * every introspect → verify roundtrip for serial / bigserial / identity PKs.
 */
function diffColumnMetadata(
  table: string,
  column: string,
  live: IntrospectedTable["columns"][number],
  declared: IntrospectedTable["columns"][number],
  entries: DriftEntry[],
): void {
  compareField(
    table,
    column,
    "nullable",
    live.nullable,
    declared.nullable,
    entries,
  );

  const bothServerGenerated =
    Boolean(live.serverGenerated) && Boolean(declared.serverGenerated);
  if (!bothServerGenerated) {
    compareField(
      table,
      column,
      "hasDefault",
      live.hasDefault,
      declared.hasDefault,
      entries,
    );
    compareField(
      table,
      column,
      "defaultExpression",
      normalizeDefaultExpression(live.defaultExpression),
      normalizeDefaultExpression(declared.defaultExpression),
      entries,
    );
  }

  compareField(
    table,
    column,
    "isPrimaryKey",
    Boolean(live.isPrimaryKey),
    Boolean(declared.isPrimaryKey),
    entries,
  );
  if (live.isPrimaryKey || declared.isPrimaryKey) {
    compareField(
      table,
      column,
      "serverGenerated",
      Boolean(live.serverGenerated),
      Boolean(declared.serverGenerated),
      entries,
    );
  }

  const liveRef = normalizeReference(live.references);
  const declaredRef = normalizeReference(declared.references);
  if (liveRef !== declaredRef) {
    entries.push({
      severity: "warn",
      kind: "type-mismatch",
      message: `column ${table}.${column} foreign key (${declaredRef} declared, ${liveRef} in db)`,
    });
  }
}

/** Compare a field of a column and return a report of drift entries. */
function compareField(
  table: string,
  column: string,
  field: string,
  live: unknown,
  declared: unknown,
  entries: DriftEntry[],
): void {
  if (live === declared) return;
  entries.push({
    severity: "warn",
    kind: "type-mismatch",
    message: `column ${table}.${column} ${field} (${formatValue(
      declared,
    )} declared, ${formatValue(live)} in db)`,
  });
}

/**
 * Normalizes FK metadata into one comparable value so missing references and
 * action changes produce a single readable drift entry.
 */
function normalizeReference(
  reference: IntrospectedTable["columns"][number]["references"],
): string {
  if (!reference) return "none";
  return [
    `${reference.schema}.${reference.table}.${reference.column}`,
    `onDelete=${reference.onDelete ?? "no action"}`,
    `onUpdate=${reference.onUpdate ?? "no action"}`,
  ].join(" ");
}

function formatValue(value: unknown): string {
  return value === undefined ? "undefined" : JSON.stringify(value);
}

/**
 * Strip the trivial `'literal'::type` cast Postgres emits around quoted
 * string defaults so that `'member'::text` (live) compares equal to `member`
 * (declared). Also unescapes `''` -> `'` inside the literal.
 *
 * Deliberately conservative:
 *   - Matches a SINGLE quoted literal followed by a single `::type` cast.
 *   - Does NOT touch expressions that contain `||`, function calls, or
 *     additional casts — those are kept verbatim and compared as-is so we
 *     don't claim equality between two non-trivially-different expressions
 *     and silently miss real drift. Example: `'foo'::text || 'bar'::text`
 *     and `'foobar'` stay distinct.
 */
function normalizeDefaultExpression(
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  const castedString = SIMPLE_CAST_LITERAL.exec(trimmed);
  if (castedString) return castedString[1].replaceAll("''", "'");
  return trimmed;
}

/**
 * Matches `'literal'::type` where the literal is a single quoted string with
 * `''` escaping and the type is a simple identifier (no parens, no `||`,
 * no further casts).
 */
const SIMPLE_CAST_LITERAL =
  /^'((?:[^']|'')*)'::[a-zA-Z_][\w]*(?:\s*\(\s*\d+\s*\))?$/;
