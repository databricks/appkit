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
        message: `+ table ${key} (exists in db, missing in schema.ts)`,
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
        message: `- table ${key} (in schema.ts, missing in db)`,
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
        message: `+ column ${key}.${name} (in db, missing in schema.ts)`,
      });
      continue;
    }

    if (liveCol.pgType !== declaredCol.pgType) {
      entries.push({
        severity: "warn",
        kind: "type-mismatch",
        message: `~ column ${key}.${name} (${declaredCol.pgType} declared, ${liveCol.pgType} in db)`,
      });
    }
    diffColumnMetadata(key, name, liveCol, declaredCol, entries);
  }

  for (const [name] of declaredCols) {
    if (!liveCols.has(name)) {
      entries.push({
        severity: "warn",
        kind: "schema-only",
        message: `- column ${key}.${name} (in schema.ts, missing in db)`,
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
    live.defaultExpression,
    declared.defaultExpression,
    entries,
  );
  compareField(
    table,
    column,
    "isPrimaryKey",
    Boolean(live.isPrimaryKey),
    Boolean(declared.isPrimaryKey),
    entries,
  );
  compareField(
    table,
    column,
    "serverGenerated",
    Boolean(live.serverGenerated),
    Boolean(declared.serverGenerated),
    entries,
  );

  const liveRef = normalizeReference(live.references);
  const declaredRef = normalizeReference(declared.references);
  if (liveRef !== declaredRef) {
    entries.push({
      severity: "warn",
      kind: "type-mismatch",
      message: `~ column ${table}.${column} foreign key (${declaredRef} declared, ${liveRef} in db)`,
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
    message: `~ column ${table}.${column} ${field} (${formatValue(
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
