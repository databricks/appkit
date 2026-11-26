import {
  DEFAULT_SCHEMA_NAME,
  isReservedColumnName,
  isReservedTableName,
} from "../../schema-builder/define-schema";
import type { AppKitTable, Schema } from "../../schema-builder/types";
import type { SchemaObject } from "../migrations";
import type {
  IntrospectedColumn,
  IntrospectedForeignKey,
  IntrospectedSequence,
  IntrospectedTable,
} from "./catalog";

export interface Skip {
  readonly table: string;
  readonly column?: string;
  readonly reason: string;
}

export interface Unexpressed extends SchemaObject {
  readonly reason: string;
}

interface SchemaSource {
  readonly source: string;
  readonly tables: readonly string[];
  readonly skipped: readonly Skip[];
  readonly unexpressed: readonly Unexpressed[];
  readonly warnings: readonly string[];
  readonly approximated: readonly string[];
}

interface RenderOptions {
  readonly importSource?: string;
  readonly previous: Schema | null;
}

type Storage =
  | "id"
  | "bigid"
  | "integer"
  | "bigint"
  | "text"
  | "varchar"
  | "boolean"
  | "uuid"
  | "timestamp"
  | "jsonb"
  | "enum";

interface BaseType {
  readonly call: string;
  readonly importName: string;
  readonly storage: Storage;
  readonly varcharLength?: number;
  readonly approximation?: string;
}

interface ColumnPlan {
  readonly column: IntrospectedColumn;
  base: BaseType;
  fk?: {
    readonly table: string;
    readonly column: string;
    readonly actions: string[];
  };
  readonly isPrimaryKey: boolean;
  readonly isUnique: boolean;
  defaultCall?: string;
  readonly comments: string[];
}

interface TablePlan {
  readonly table: IntrospectedTable;
  readonly columns: ColumnPlan[];
  readonly comments: string[];
  readonly body: Array<ColumnPlan | string>;
  variable: string;
}

const JS_RESERVED = new Set(
  (
    "break case catch class const continue debugger default delete do else enum export extends false finally for " +
    "function if import in instanceof new null return super switch this throw true try typeof var void while with " +
    "yield let static implements interface package private protected public await arguments eval undefined"
  ).split(" "),
);
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const INT32 = { min: -2147483648, max: 2147483647 };

/**
 * Line separators end a `//` comment, and bidi controls reorder what an editor
 * shows. JSON.stringify keeps both.
 */
const UNSAFE_IN_SOURCE =
  /[\u061c\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const escaped = (char: string) =>
  `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
const q = (value: string) =>
  JSON.stringify(value).replace(UNSAFE_IN_SOURCE, escaped);
/**
 * Catalog text for a `//` comment or a terminal line. A quoted Postgres name can
 * hold a newline, which would end the comment and turn the rest of the name
 * into code.
 */
export const shown = (text: string) =>
  Array.from(text, (char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? escaped(char) : char;
  })
    .join("")
    .replace(UNSAFE_IN_SOURCE, escaped);
/** Postgres keeps the first 63 bytes of a name, cut on a character boundary. */
function pgName(name: string): string {
  let bytes = 0;
  let kept = "";
  for (const char of name) {
    bytes += Buffer.byteLength(char);
    if (bytes > 63) break;
    kept += char;
  }
  return kept;
}
const key = (name: string) => (IDENTIFIER.test(name) ? name : q(name));
const access = (variable: string, name: string) =>
  IDENTIFIER.test(name) ? `${variable}.${name}` : `${variable}[${q(name)}]`;
const client = (table: string) => access("app.database", table);
const list = (names: readonly string[]) => names.join(", ");

function baseType(
  column: IntrospectedColumn,
  schemaName: string,
): BaseType | string {
  const type = column.type;
  if (column.enum) {
    if (column.enum.schema !== schemaName) {
      return `enum type "${column.enum.schema}.${column.enum.name}" lives outside schema "${schemaName}"`;
    }
    if (column.enum.values.length === 0) {
      return `enum type "${column.enum.name}" has no values`;
    }
    if (column.enum.values.includes("")) {
      return `enum type "${column.enum.name}" has an empty label, which the builder does not accept`;
    }
    return {
      call: `enumType(${q(column.enum.name)}, [${column.enum.values.map(q).join(", ")}])`,
      importName: "",
      storage: "enum",
    };
  }
  switch (type) {
    case "integer":
      return { call: "integer()", importName: "integer", storage: "integer" };
    case "bigint":
      return { call: "bigint()", importName: "bigint", storage: "bigint" };
    case "text":
      return { call: "text()", importName: "text", storage: "text" };
    case "character varying":
      return {
        call: "text()",
        importName: "text",
        storage: "text",
        approximation:
          "character varying without a length is declared as text()",
      };
    case "boolean":
      return { call: "boolean()", importName: "boolean", storage: "boolean" };
    case "uuid":
      return { call: "uuid()", importName: "uuid", storage: "uuid" };
    case "jsonb":
      return { call: "jsonb()", importName: "jsonb", storage: "jsonb" };
  }
  const varchar = /^character varying\((\d+)\)$/.exec(type);
  if (varchar) {
    const length = Number(varchar[1]);
    return {
      call: `varchar(${length})`,
      importName: "varchar",
      storage: "varchar",
      varcharLength: length,
    };
  }
  const timestamp = /^timestamp(\(\d\))? (with|without) time zone$/.exec(type);
  if (timestamp) {
    return {
      call:
        timestamp[2] === "with"
          ? "timestamp({ withTimezone: true })"
          : "timestamp()",
      importName: "timestamp",
      storage: "timestamp",
      ...(timestamp[1]
        ? { approximation: `${type} is declared without its precision` }
        : {}),
    };
  }
  return `type "${type}" is not supported`;
}

const isSequenceDefault = (expr: string | null) =>
  !!expr && /^nextval\(/.test(expr);

const SERVER_KEYS = {
  integer: {
    base: { call: "id()", importName: "id", storage: "id" },
    max: "2147483647",
  },
  bigint: {
    base: { call: "bigid()", importName: "bigid", storage: "bigid" },
    max: "9223372036854775807",
  },
} as const satisfies Record<string, { base: BaseType; max: string }>;
const SEQUENCE_DEFAULTS = { start: "1", increment: "1", min: "1", cache: "1" };
const SEQUENCE_CLAUSES: ReadonlyArray<
  [Exclude<keyof IntrospectedSequence, "cycle">, string]
> = [
  ["start", "START WITH"],
  ["increment", "INCREMENT BY"],
  ["min", "MINVALUE"],
  ["max", "MAXVALUE"],
  ["cache", "CACHE"],
];

function sequenceDifferences(
  sequence: IntrospectedSequence,
  max: string,
): { has: string; declared: string } | null {
  const defaults = { ...SEQUENCE_DEFAULTS, max };
  const has: string[] = [];
  const declared: string[] = [];
  for (const [option, clause] of SEQUENCE_CLAUSES) {
    if (sequence[option] === defaults[option]) continue;
    has.push(`${clause} ${sequence[option]}`);
    declared.push(`${clause} ${defaults[option]}`);
  }
  if (sequence.cycle) {
    has.push("CYCLE");
    declared.push("NO CYCLE");
  }
  return has.length > 0 ? { has: list(has), declared: list(declared) } : null;
}

/**
 * A quoted literal, with the cast pg_get_expr adds: `'x'::text`, `'x'::character
 * varying`, `'x'::app."order-status"`. A quoted name holds any character but `"`.
 */
const LITERAL_WITH_CAST = /^'((?:[^']|'')*)'(?:::(?:[\w .]|"(?:[^"]|"")*")+)?$/;

function defaultCall(
  expr: string,
  base: BaseType,
  enumValues: readonly string[] | undefined,
): { call: string } | { skip: string } {
  const unsupported = { skip: `default ${expr} is not supported` };
  switch (base.storage) {
    case "timestamp":
      return /^(now\(\)|CURRENT_TIMESTAMP)$/i.test(expr)
        ? { call: ".defaultNow()" }
        : unsupported;
    case "uuid":
      return expr === "gen_random_uuid()"
        ? { call: ".defaultRandom()" }
        : unsupported;
    case "boolean":
      return expr === "true" || expr === "false"
        ? { call: `.default(${expr})` }
        : unsupported;
    case "integer": {
      const match = /^\(?'?(-?\d+)'?(?:::integer)?\)?$/.exec(expr);
      const value = match ? Number(match[1]) : Number.NaN;
      return Number.isInteger(value) && value >= INT32.min && value <= INT32.max
        ? { call: `.default(${value})` }
        : unsupported;
    }
    case "text":
    case "varchar":
    case "enum": {
      const match = LITERAL_WITH_CAST.exec(expr);
      if (!match) return unsupported;
      const value = (match[1] ?? "").replace(/''/g, "'");
      if (
        base.storage === "varchar" &&
        value.length > (base.varcharLength ?? 0)
      ) {
        return unsupported;
      }
      if (base.storage === "enum" && !enumValues?.includes(value)) {
        return unsupported;
      }
      return { call: `.default(${q(value)})` };
    }
    default:
      return unsupported;
  }
}

function importLine(names: readonly string[], source: string): string {
  const line = `import { ${names.join(", ")} } from ${q(source)};`;
  if (line.length <= 80) return line;
  return `import {\n${names.map((name) => `  ${name},`).join("\n")}\n} from ${q(source)};`;
}

type Omission =
  | { readonly kind: "table"; readonly table: string; readonly reason: string }
  | {
      readonly kind: "column";
      readonly table: string;
      readonly column: string;
      readonly reason: string;
      readonly failsInserts: boolean;
    }
  | {
      readonly kind: "default";
      readonly table: string;
      readonly column: string;
      readonly defaultExpr: string;
      readonly reason: string;
      readonly failsInserts: boolean;
    }
  | {
      readonly kind: "constraint";
      readonly table: string;
      readonly names: readonly string[];
      readonly columns: string | null;
      readonly listed: boolean;
      readonly reason: string;
    }
  | { readonly kind: "type"; readonly name: string; readonly reason: string };

const TYPED_DEFAULTS = new Set([".defaultRandom()", ".defaultNow()"]);

function mirrored(target: BaseType): string {
  if (target.storage === "id") return "integer()";
  if (target.storage === "bigid") return "bigint()";
  return target.call;
}

export function renderSchemaSource(
  tables: readonly IntrospectedTable[],
  schemaName: string,
  options: RenderOptions,
): SchemaSource {
  const skipped: Skip[] = [];
  const unexpressed: Unexpressed[] = [];
  const warnings: string[] = [];
  const approximated: string[] = [];
  const renamed: string[] = [];
  const tableComments: string[] = [];
  const qualified = (table: string, column?: string) =>
    `${schemaName}.${table}${column ? `.${column}` : ""}`;
  const omit = (omission: Omission, comments?: Pick<string[], "push">) => {
    const { reason } = omission;
    const skip = (table: string, column?: string) =>
      skipped.push({
        table: shown(table),
        ...(column === undefined ? {} : { column: shown(column) }),
        reason: shown(reason),
      });
    switch (omission.kind) {
      case "type":
        unexpressed.push({ ...omission });
        return;
      case "table": {
        const { table } = omission;
        unexpressed.push({ kind: "table", name: table, reason });
        skip(table);
        comments?.push(
          `// appkit: skipped table "${shown(table)}": ${shown(reason)}`,
        );
        return;
      }
      case "column": {
        const { table, column } = omission;
        unexpressed.push({
          kind: "column",
          name: table,
          member: column,
          reason,
        });
        skip(table, column);
        comments?.push(
          `// appkit: skipped column "${shown(column)}": ${shown(reason)}`,
        );
        if (omission.failsInserts) {
          warnings.push(
            `${qualified(table, column)} is NOT NULL with no default but is not in schema.ts (${reason}). Inserts through ${client(table)} will fail until it gets a default, becomes nullable, or is dropped.`,
          );
        }
        return;
      }
      case "default": {
        const { table, column } = omission;
        unexpressed.push({
          kind: "default",
          name: table,
          member: column,
          reason,
        });
        skip(table, column);
        comments?.push(`// appkit: skipped ${shown(reason)}`);
        if (omission.failsInserts) {
          warnings.push(
            `${qualified(table, column)}: its default ${omission.defaultExpr} is not in schema.ts, so ${client(table)} requires a value for it on insert.`,
          );
        }
        return;
      }
      case "constraint": {
        const { table } = omission;
        for (const member of omission.names) {
          unexpressed.push({ kind: "constraint", name: table, member, reason });
        }
        if (!omission.listed) return;
        skip(table, omission.columns ?? undefined);
        comments?.push(`// appkit: skipped ${shown(reason)}`);
        return;
      }
    }
  };
  const skipTable = (table: string, reason: string) =>
    omit({ kind: "table", table, reason }, tableComments);
  const columnBase = (
    column: IntrospectedColumn,
    isPrimaryKey: boolean,
  ): BaseType | string => {
    if (isReservedColumnName(column.name)) {
      return `the name "${column.name}" is reserved by AppKit`;
    }
    if (column.generated) return "generated columns are not supported";
    const base = baseType(column, schemaName);
    if (typeof base === "string" || column.identity === "" || isPrimaryKey) {
      return base;
    }
    return "identity columns other than the primary key are not supported";
  };
  const { previous } = options;
  const previousTables = new Map<string, AppKitTable>(
    previous && previous.$schemaName === schemaName
      ? Object.values(previous.$tables).map((table): [string, AppKitTable] => [
          table.$name,
          table,
        ])
      : [],
  );
  const declaresForeignKey = (
    table: string,
    foreignKey: IntrospectedForeignKey,
  ): boolean =>
    foreignKey.columns.length === 1 &&
    (previousTables
      .get(table)
      ?.$relations.some(
        (relation) =>
          relation.cardinality === "toOne" &&
          relation.localColumn === foreignKey.columns[0] &&
          relation.targetTable === foreignKey.table &&
          relation.targetColumn === foreignKey.refColumns[0],
      ) ??
      false);
  const isPrivate = (table: string, column: string): boolean =>
    Object.values(previousTables.get(table)?.$columns ?? {}).find(
      (meta) => meta.columnName === column,
    )?.isPrivate ?? false;

  const names = new Set(tables.map((table) => table.name));
  const plans = new Map<string, TablePlan>();
  for (const table of tables) {
    if (isReservedTableName(table.name)) {
      skipTable(table.name, `the name "${table.name}" is reserved by AppKit`);
    } else if (
      table.name.endsWith("Relations") &&
      names.has(table.name.slice(0, -"Relations".length))
    ) {
      skipTable(
        table.name,
        `the name collides with the relation metadata AppKit generates for "${table.name.slice(0, -"Relations".length)}"`,
      );
    } else if (table.primaryKey.length === 0) {
      skipTable(table.name, "it has no primary key");
    } else if (table.primaryKey.length > 1) {
      skipTable(
        table.name,
        `composite primary key (${list(table.primaryKey)}) is not supported`,
      );
    } else {
      plans.set(table.name, {
        table,
        columns: [],
        comments: [],
        body: [],
        variable: "",
      });
    }
  }

  for (const plan of [...plans.values()]) {
    const { table } = plan;
    const pk = table.primaryKey[0] as string;
    const pkColumn = table.columns.find((column) => column.name === pk);
    const pkBase = pkColumn ? columnBase(pkColumn, true) : "unsupported";
    if (typeof pkBase === "string") {
      plans.delete(table.name);
      skipTable(
        table.name,
        `its primary key column "${pk}" cannot be expressed (${pkBase})`,
      );
      continue;
    }
    const singleUnique = new Map(
      table.unique
        .filter((unique) => unique.columns.length === 1)
        .map((unique) => [unique.columns[0] as string, unique]),
    );
    for (const unique of table.unique.filter((u) => u.columns.length > 1)) {
      omit(
        {
          kind: "constraint",
          table: table.name,
          names: [unique.name],
          columns: null,
          listed: true,
          reason: `unique constraint (${list(unique.columns)}) spans several columns, which is not supported`,
        },
        plan.comments,
      );
    }

    for (const column of table.columns) {
      const isPrimaryKey = column.name === pk;
      const base = columnBase(column, isPrimaryKey);
      if (typeof base === "string") {
        const generatesValue =
          column.identity !== "" || column.generated || !!column.defaultExpr;
        omit(
          {
            kind: "column",
            table: table.name,
            column: column.name,
            reason: base,
            failsInserts: column.notNull && !generatesValue,
          },
          plan.body,
        );
        continue;
      }

      const columnPlan: ColumnPlan = {
        column,
        base,
        isPrimaryKey,
        isUnique: singleUnique.has(column.name) && !isPrimaryKey,
        comments: [],
      };
      if (base.approximation) {
        approximated.push(
          `${qualified(table.name, column.name)}: ${base.approximation}`,
        );
      }
      const unique = singleUnique.get(column.name);
      const migrationsUnique = pgName(`${table.name}_${column.name}_unique`);
      if (columnPlan.isUnique && unique) {
        if (unique.name !== migrationsUnique) {
          renamed.push(`${unique.name} (${migrationsUnique})`);
        }
        if (unique.deferrable) {
          approximated.push(
            `${qualified(table.name, column.name)}: the unique constraint is declared without DEFERRABLE`,
          );
        }
      }
      const generatesKey =
        column.identity !== "" || isSequenceDefault(column.defaultExpr);
      if (
        isPrimaryKey &&
        generatesKey &&
        (base.storage === "integer" || base.storage === "bigint")
      ) {
        const serverKey = SERVER_KEYS[base.storage];
        columnPlan.base = serverKey.base;
        if (column.identity !== "d") {
          approximated.push(
            `${qualified(table.name, column.name)}: ${column.identity === "a" ? "GENERATED ALWAYS AS IDENTITY" : "a serial key"} is declared as ${serverKey.base.call}, an identity generated BY DEFAULT`,
          );
        }
        const differences = column.sequence
          ? sequenceDifferences(column.sequence, serverKey.max)
          : null;
        if (differences) {
          approximated.push(
            `${qualified(table.name, column.name)}: the key's sequence has ${differences.has}; ${serverKey.base.call} declares the defaults (${differences.declared})`,
          );
        }
      } else if (column.defaultExpr) {
        const parsed = defaultCall(
          column.defaultExpr,
          base,
          column.enum?.values,
        );
        if ("call" in parsed) {
          columnPlan.defaultCall = parsed.call;
        } else {
          omit(
            {
              kind: "default",
              table: table.name,
              column: column.name,
              defaultExpr: column.defaultExpr,
              reason: parsed.skip,
              failsInserts: column.notNull,
            },
            columnPlan.comments,
          );
        }
      }
      plan.columns.push(columnPlan);
      plan.body.push(columnPlan);
    }

    if (table.partitioned) {
      approximated.push(
        `${qualified(table.name)}: a partitioned table is declared as a plain table`,
      );
    }
    for (const [one, many, names] of [
      [
        "CHECK or EXCLUDE constraint",
        "CHECK or EXCLUDE constraints",
        table.checks,
      ],
      ["index", "indexes", table.indexes],
    ] as const) {
      if (names.length > 0) {
        const single = names.length === 1;
        warnings.push(
          `${qualified(table.name)}: ${single ? `${one} ${names[0]} is` : `${many} ${list(names)} are`} not in schema.ts, so a database the migrations create will not have ${single ? "it" : "them"}.`,
        );
      }
    }
  }

  const edges = new Map<string, Set<string>>();
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const node = stack.pop() as string;
      if (node === to) return true;
      if (seen.has(node)) continue;
      seen.add(node);
      stack.push(...(edges.get(node) ?? []));
    }
    return false;
  };
  const fkProblem = (
    plan: TablePlan,
    foreignKey: IntrospectedForeignKey,
    source: ColumnPlan | undefined,
    seenTargets: ReadonlySet<string>,
  ): string | null => {
    if (foreignKey.columns.length !== 1) {
      return "foreign keys over several columns are not supported";
    }
    if (!source) return "its column is skipped";
    if (source.fk) {
      return `its column already keeps the foreign key to ${source.fk.table}(${source.fk.column})`;
    }
    if (foreignKey.schema !== schemaName) {
      return `it references schema "${foreignKey.schema}"`;
    }
    if (foreignKey.table === plan.table.name) {
      return "introspect does not write self-references";
    }
    const target = plans.get(foreignKey.table);
    if (!target) return `table "${foreignKey.table}" is skipped`;
    const targetColumn = target.columns.find(
      (c) => c.column.name === foreignKey.refColumns[0],
    );
    if (!targetColumn) {
      return `column ${foreignKey.table}.${foreignKey.refColumns[0]} is skipped`;
    }
    if (!targetColumn.isPrimaryKey && !targetColumn.isUnique) {
      return `${foreignKey.table}.${foreignKey.refColumns[0]} is not a primary key or single-column unique key`;
    }
    if (seenTargets.has(foreignKey.table)) {
      return `a second foreign key to "${foreignKey.table}" would make the relation ambiguous`;
    }
    if (plan.table.columns.some((c) => c.name === foreignKey.table)) {
      return `the relation "${foreignKey.table}" would clash with the column of the same name`;
    }
    if (target.table.columns.some((c) => c.name === plan.table.name)) {
      return `the reverse relation "${plan.table.name}" would clash with column ${foreignKey.table}.${plan.table.name}`;
    }
    if (reaches(foreignKey.table, plan.table.name)) {
      // TypeScript cannot infer a cycle of fk() thunks without TableHandle annotations (TS7022).
      return "it would close a cycle of foreign keys";
    }
    if (mirrored(targetColumn.base) !== source.base.call) {
      return `its type ${source.base.call} differs from ${foreignKey.table}.${foreignKey.refColumns[0]}`;
    }
    const actions = [foreignKey.onDelete, foreignKey.onUpdate];
    if (actions.includes("set null") && source.column.notNull) {
      return "SET NULL on a NOT NULL column";
    }
    const fkDefault =
      source.defaultCall && !TYPED_DEFAULTS.has(source.defaultCall);
    if (actions.includes("set default") && !fkDefault) {
      return "SET DEFAULT without a default the builder can express";
    }
    return null;
  };

  for (const plan of plans.values()) {
    const targets = new Set<string>();
    const foreignKeys = [...plan.table.foreignKeys].sort(
      (a, b) =>
        Number(declaresForeignKey(plan.table.name, b)) -
        Number(declaresForeignKey(plan.table.name, a)),
    );
    for (const foreignKey of foreignKeys) {
      const source = plan.columns.find(
        (c) => c.column.name === foreignKey.columns[0],
      );
      const problem = fkProblem(plan, foreignKey, source, targets);
      if (problem) {
        const names = [foreignKey.name];
        if (foreignKey.columns.length === 1) {
          names.push(
            pgName(
              `${plan.table.name}_${foreignKey.columns[0]}_${foreignKey.table}_${foreignKey.refColumns[0]}_fk`,
            ),
          );
        }
        omit(
          {
            kind: "constraint",
            table: plan.table.name,
            names: [...new Set(names)],
            columns: foreignKey.columns.join(", "),
            listed: !!source || foreignKey.columns.length > 1,
            reason: `foreign key to ${foreignKey.table}(${list(foreignKey.refColumns)}) is not kept: ${problem}`,
          },
          source?.comments ?? plan.comments,
        );
        continue;
      }
      const sourceColumn = source as ColumnPlan;
      const target = plans.get(foreignKey.table) as TablePlan;
      const targetColumn = target.columns.find(
        (c) => c.column.name === foreignKey.refColumns[0],
      ) as ColumnPlan;
      sourceColumn.base = { ...targetColumn.base };
      if (
        sourceColumn.defaultCall &&
        TYPED_DEFAULTS.has(sourceColumn.defaultCall)
      ) {
        const defaultExpr = sourceColumn.column.defaultExpr as string;
        omit(
          {
            kind: "default",
            table: plan.table.name,
            column: sourceColumn.column.name,
            defaultExpr,
            reason: `default ${defaultExpr} is not supported on a foreign key column`,
            failsInserts: sourceColumn.column.notNull,
          },
          sourceColumn.comments,
        );
        delete sourceColumn.defaultCall;
      }
      for (const [flag, what] of [
        [foreignKey.deferrable, "DEFERRABLE"],
        [foreignKey.matchFull, "MATCH FULL"],
      ] as const) {
        if (flag) {
          approximated.push(
            `${qualified(plan.table.name, sourceColumn.column.name)}: the foreign key is declared without ${what}`,
          );
        }
      }
      const migrationsFk = pgName(
        `${plan.table.name}_${sourceColumn.column.name}_${foreignKey.table}_${foreignKey.refColumns[0]}_fk`,
      );
      if (foreignKey.name !== migrationsFk) {
        renamed.push(`${foreignKey.name} (${migrationsFk})`);
      }
      sourceColumn.fk = {
        table: foreignKey.table,
        column: foreignKey.refColumns[0] as string,
        actions: [
          ...(foreignKey.onDelete !== "no action"
            ? [`.onDelete(${q(foreignKey.onDelete)})`]
            : []),
          ...(foreignKey.onUpdate !== "no action"
            ? [`.onUpdate(${q(foreignKey.onUpdate)})`]
            : []),
        ],
      };
      targets.add(foreignKey.table);
      const out = edges.get(plan.table.name) ?? new Set<string>();
      out.add(foreignKey.table);
      edges.set(plan.table.name, out);
    }
  }

  const declaredEnums = new Set(
    [...plans.values()].flatMap((plan) =>
      plan.columns.flatMap((c) =>
        c.base.storage === "enum" && c.column.enum ? [c.column.enum.name] : [],
      ),
    ),
  );
  const undeclaredEnums = new Set(
    tables.flatMap((table) =>
      table.columns.flatMap((column) =>
        column.enum?.schema === schemaName &&
        !declaredEnums.has(column.enum.name)
          ? [column.enum.name]
          : [],
      ),
    ),
  );
  for (const name of undeclaredEnums) {
    omit({
      kind: "type",
      name,
      reason: "only what schema.ts leaves out uses it",
    });
  }

  const ordered: TablePlan[] = [];
  const placed = new Set<string>();
  const place = (plan: TablePlan) => {
    if (placed.has(plan.table.name)) return;
    placed.add(plan.table.name);
    for (const target of [...(edges.get(plan.table.name) ?? [])].sort()) {
      const targetPlan = plans.get(target);
      if (targetPlan) place(targetPlan);
    }
    ordered.push(plan);
  };
  for (const plan of plans.values()) place(plan);

  const imports = new Set<string>(["defineSchema"]);
  for (const plan of ordered) {
    for (const column of plan.columns) {
      if (column.fk) imports.add("fk");
      else if (column.base.importName) imports.add(column.base.importName);
    }
  }
  const usesEnum = ordered.some((plan) =>
    plan.columns.some((c) => !c.fk && c.base.storage === "enum"),
  );
  const used = new Set<string>([...imports, "table", "enumType", "schema"]);
  for (const plan of ordered) {
    let candidate = plan.table.name.replace(/[^A-Za-z0-9_$]/g, "_");
    if (!/^[A-Za-z_$]/.test(candidate)) candidate = `_${candidate}`;
    if (used.has(candidate) || JS_RESERVED.has(candidate)) {
      candidate = `${candidate}Table`;
    }
    let variable = candidate;
    for (let n = 2; used.has(variable); n++) variable = `${candidate}${n}`;
    used.add(variable);
    plan.variable = variable;
  }

  const lines: string[] = [
    `// Generated by \`appkit db introspect\` from schema "${shown(schemaName)}". Edit tables here,`,
    "// then run `npx appkit db migrate` on your dev branch.",
    importLine(
      [...imports].sort(),
      options.importSource ?? "@databricks/appkit/beta",
    ),
    "",
  ];
  const schemaOption =
    schemaName === DEFAULT_SCHEMA_NAME
      ? undefined
      : `{ schemaName: ${q(schemaName)} }`;
  if (renamed.length > 0) {
    warnings.push(
      `Constraint names differ from the ones migrations use: ${list(renamed)}. A later migration that drops or changes one of them fails until it is renamed in the database (ALTER TABLE … RENAME CONSTRAINT).`,
    );
  }
  const result = (source: string): SchemaSource => ({
    source,
    tables: ordered.map((plan) => plan.table.name),
    skipped,
    unexpressed,
    warnings: warnings.map(shown),
    approximated: approximated.map(shown),
  });
  if (ordered.length === 0) {
    lines.push(...tableComments);
    lines.push(
      `export const schema = defineSchema(() => ({})${schemaOption ? `, ${schemaOption}` : ""});`,
      "",
    );
    return result(lines.join("\n"));
  }

  const body: string[] = [];
  for (const plan of ordered) {
    body.push(`  const ${plan.variable} = table(${q(plan.table.name)}, {`);
    for (const comment of plan.comments) body.push(`    ${comment}`);
    for (const entry of plan.body) {
      if (typeof entry === "string") {
        body.push(`    ${entry}`);
        continue;
      }
      const column = entry;
      for (const comment of column.comments) body.push(`    ${comment}`);
      const chain: string[] = [];
      const head = column.fk
        ? `fk(() => ${access((plans.get(column.fk.table) as TablePlan).variable, column.fk.column)})`
        : column.base.call;
      const serverKey =
        !column.fk &&
        (column.base.storage === "id" || column.base.storage === "bigid");
      if (column.isPrimaryKey && !serverKey) chain.push(".primaryKey()");
      else if (column.column.notNull && !serverKey) chain.push(".notNull()");
      if (column.isUnique) chain.push(".unique()");
      if (column.defaultCall) chain.push(column.defaultCall);
      chain.push(...(column.fk?.actions ?? []));
      if (isPrivate(plan.table.name, column.column.name)) {
        chain.push(".private()");
      }
      body.push(`    ${key(column.column.name)}: ${head}${chain.join("")},`);
    }
    body.push("  });", "");
  }
  for (const comment of tableComments) body.push(`  ${comment}`);
  if (tableComments.length > 0) body.push("");
  const entries = ordered.map((plan) =>
    plan.variable === plan.table.name
      ? plan.variable
      : `${key(plan.table.name)}: ${plan.variable}`,
  );
  body.push(`  return { ${entries.join(", ")} };`);

  const builder = `({ table${usesEnum ? ", enum: enumType" : ""} }) =>`;
  if (schemaOption) {
    lines.push(
      "export const schema = defineSchema(",
      `  ${builder} {`,
      ...body.map((line) => (line ? `  ${line}` : line)),
      "  },",
      `  ${schemaOption},`,
      ");",
      "",
    );
  } else {
    lines.push(
      `export const schema = defineSchema(${builder} {`,
      ...body,
      "});",
      "",
    );
  }
  return result(lines.join("\n"));
}
