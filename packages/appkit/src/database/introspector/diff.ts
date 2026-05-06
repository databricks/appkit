import type { IntrospectedTable, IntrospectionResult } from "./types";

export type DriftSeverity = "info" | "warn" | "error";

export interface DriftEntry {
  severity: DriftSeverity;
  kind: "live-only" | "schema-only" | "type-mismatch";
  message: string;
}

export interface DriftReport {
  hasDrift: boolean;
  entries: DriftEntry[];
}

/**
 * TODO(rls): policies are not compared — `schemaToIntrospection` always
 * returns `policies: []`, so any DB-side policy would show as `live-only`.
 * Re-enable once the schema-builder declares policies.
 */
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

function tableKey(table: Pick<IntrospectedTable, "schema" | "name">): string {
  return `${table.schema}.${table.name}`;
}

/**
 * Compare column metadata beyond `pgType` (nullable, default, PK, FK).
 * Skip default/hasDefault when both sides are server-generated — the live DB
 * stores `nextval(...)` / `GENERATED AS IDENTITY` while the schema flags it
 * as `serverGenerated: true`; direct compare would noise-flag every serial PK.
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

/** Flatten FK metadata to one comparable string for a single drift entry. */
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
 * Strip Postgres's `'literal'::type` cast so `'member'::text` (live) compares
 * equal to `member` (declared); unescape `''` → `'`. Conservative: only one
 * quoted literal + one cast; expressions with `||`, function calls, or extra
 * casts pass through verbatim — better a false positive than missed drift.
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

/** `'literal'::type` — single quoted string + simple type identifier only. */
const SIMPLE_CAST_LITERAL =
  /^'((?:[^']|'')*)'::[a-zA-Z_][\w]*(?:\s*\(\s*\d+\s*\))?$/;
