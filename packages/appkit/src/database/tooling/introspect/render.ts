import { DEFAULT_SCHEMA_NAME } from "../../schema-builder/define-schema";
import type {
  IntrospectedColumn,
  IntrospectedForeignKey,
  IntrospectedTable,
} from "./catalog";

/**
 * Something introspect left out of schema.ts, with an `// appkit: skipped …` comment.
 * Display text: catalog names come with control characters escaped (see shown()).
 */
export interface Skip {
  readonly table: string;
  readonly column?: string;
  readonly reason: string;
}

interface SchemaSource {
  readonly source: string;
  /** Tables written to schema.ts. */
  readonly tables: readonly string[];
  readonly skipped: readonly Skip[];
  /** Omissions that change behavior, e.g. a NOT NULL column the API can no longer fill. */
  readonly warnings: readonly string[];
  /** What schema.ts declares differently from the database, which keeps it as it is. */
  readonly approximated: readonly string[];
}

interface RenderOptions {
  /** Module the builder is imported from. Default "@databricks/appkit/beta". */
  readonly importSource?: string;
}

/** Storage as the builder sees it; id/bigid are server-generated integer/bigint keys. */
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
  /** Builder call, e.g. `varchar(120)`. */
  readonly call: string;
  /** Import it needs ("" for the context's enum). */
  readonly importName: string;
  readonly storage: Storage;
  readonly varcharLength?: number;
  /** How the call differs from the database type. */
  readonly approximation?: string;
}

interface ColumnPlan {
  readonly column: IntrospectedColumn;
  base: BaseType;
  /** Set when `fk(() => <table>.<column>)` replaces the base call. */
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
  /** Table-level comments, rendered first. */
  readonly comments: string[];
  /** Columns and skipped-column comments, in catalog order. */
  readonly body: Array<ColumnPlan | string>;
  variable: string;
}

const RESERVED_TABLE_NAMES = new Set([
  "sql",
  "transaction",
  "__proto__",
  "prototype",
  "constructor",
]);
const RESERVED_COLUMN_NAMES = new Set([
  "and",
  "or",
  "__proto__",
  "prototype",
  "constructor",
]);
const JS_RESERVED = new Set(
  (
    "break case catch class const continue debugger default delete do else enum export extends false finally for " +
    "function if import in instanceof new null return super switch this throw true try typeof var void while with " +
    "yield let static implements interface package private protected public await arguments eval undefined"
  ).split(" "),
);
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const INT32 = { min: -2147483648, max: 2147483647 };

const q = (value: string) => JSON.stringify(value);
/**
 * Catalog text for a `//` comment or a terminal line. A quoted Postgres name can
 * hold a newline (or U+2028/U+2029, which JSON.stringify keeps), which would end
 * the comment and turn the rest of the name into code.
 */
const shown = (text: string) =>
  Array.from(text, (char) => {
    const code = char.charCodeAt(0);
    const breaks =
      code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029;
    return breaks ? `\\u${code.toString(16).padStart(4, "0")}` : char;
  }).join("");
/** Postgres keeps the first 63 bytes of a name. */
const pgName = (name: string) => name.slice(0, 63);
const key = (name: string) =>
  IDENTIFIER.test(name) && name !== "__proto__" ? name : q(name);
const access = (variable: string, name: string) =>
  IDENTIFIER.test(name) ? `${variable}.${name}` : `${variable}[${q(name)}]`;
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

/** A builder default call, or why the database default cannot be expressed. */
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
      const match = /^'((?:[^']|'')*)'(?:::[\w." ]+)?$/.exec(expr);
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
      // The builder accepts no literal defaults for bigint and jsonb.
      return unsupported;
  }
}

function importLine(names: readonly string[], source: string): string {
  const line = `import { ${names.join(", ")} } from ${q(source)};`;
  if (line.length <= 80) return line;
  return `import {\n${names.map((name) => `  ${name},`).join("\n")}\n} from ${q(source)};`;
}

function makeSkip(
  table: string,
  column: string | undefined,
  reason: string,
): Skip {
  return {
    table: shown(table),
    ...(column === undefined ? {} : { column: shown(column) }),
    reason: shown(reason),
  };
}

function skipComment(skip: Skip): string {
  return `// appkit: skipped ${skip.column ? `column "${skip.column}"` : `table "${skip.table}"`}: ${skip.reason}`;
}

/** Defaults the builder allows only on uuid / timestamp columns, never on fk(). */
const TYPED_DEFAULTS = new Set([".defaultRandom()", ".defaultNow()"]);

/** The storage an fk() column inherits from its target. */
function mirrored(target: BaseType): string {
  if (target.storage === "id") return "integer()";
  if (target.storage === "bigid") return "bigint()";
  return target.call;
}

/**
 * Render pg_catalog tables as a `defineSchema` source the builder accepts.
 * What the builder cannot express is left out with an `// appkit: skipped …`
 * comment; what it declares differently (a timestamp without its precision,
 * say) is listed in `approximated`.
 */
export function renderSchemaSource(
  tables: readonly IntrospectedTable[],
  schemaName: string,
  options: RenderOptions = {},
): SchemaSource {
  const skipped: Skip[] = [];
  const warnings: string[] = [];
  const approximated: string[] = [];
  /** Constraints whose database name is not the one migrations use: "db (migrations)". */
  const renamed: string[] = [];
  const tableComments: string[] = [];
  const qualified = (table: string, column?: string) =>
    `${schemaName}.${table}${column ? `.${column}` : ""}`;
  const skipTable = (table: string, reason: string) => {
    const skip = makeSkip(table, undefined, reason);
    skipped.push(skip);
    tableComments.push(skipComment(skip));
  };

  // 1. Tables the builder can key: one primary-key column, a usable name.
  const names = new Set(tables.map((table) => table.name));
  const plans = new Map<string, TablePlan>();
  for (const table of tables) {
    if (RESERVED_TABLE_NAMES.has(table.name)) {
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

  // 2. Columns. A table whose primary-key column cannot be expressed is skipped whole.
  for (const plan of [...plans.values()]) {
    const { table } = plan;
    const pk = table.primaryKey[0];
    const tableSkips: Skip[] = [];
    const tableWarnings: string[] = [];
    const tableApproximated: string[] = [];
    const tableRenamed: string[] = [];
    const columnReasons = new Map<string, string>();
    /** Single-column unique constraints: column → constraint name. */
    const singleUnique = new Map(
      table.unique
        .filter((unique) => unique.columns.length === 1)
        .map((unique) => [unique.columns[0] as string, unique.name]),
    );
    for (const unique of table.unique.filter((u) => u.columns.length > 1)) {
      const skip = makeSkip(
        table.name,
        undefined,
        `unique constraint (${list(unique.columns)}) spans several columns, which is not supported`,
      );
      tableSkips.push(skip);
      plan.comments.push(`// appkit: skipped ${skip.reason}`);
    }

    for (const column of table.columns) {
      const skipColumn = (reason: string) => {
        const skip = makeSkip(table.name, column.name, reason);
        tableSkips.push(skip);
        columnReasons.set(column.name, reason);
        plan.body.push(skipComment(skip));
        const generatesValue =
          column.identity !== "" || column.generated || !!column.defaultExpr;
        if (column.notNull && !generatesValue) {
          tableWarnings.push(
            `${qualified(table.name, column.name)} is NOT NULL with no default but is not in schema.ts (${reason}). Inserts through the API will fail until it gets a default, becomes nullable, or is dropped.`,
          );
        }
      };

      if (
        column.name.startsWith("$") ||
        RESERVED_COLUMN_NAMES.has(column.name)
      ) {
        skipColumn(`the name "${column.name}" is reserved by AppKit`);
        continue;
      }
      if (column.generated) {
        skipColumn("generated columns are not supported");
        continue;
      }
      const base = baseType(column, schemaName);
      if (typeof base === "string") {
        skipColumn(base);
        continue;
      }
      const isPrimaryKey = column.name === pk;
      if (column.identity !== "" && !isPrimaryKey) {
        skipColumn(
          "identity columns other than the primary key are not supported",
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
        tableApproximated.push(
          `${qualified(table.name, column.name)}: ${base.approximation}`,
        );
      }
      const uniqueName = singleUnique.get(column.name);
      const migrationsUnique = pgName(`${table.name}_${column.name}_unique`);
      if (columnPlan.isUnique && uniqueName !== migrationsUnique) {
        tableRenamed.push(`${uniqueName} (${migrationsUnique})`);
      }
      const generatesKey =
        column.identity !== "" || isSequenceDefault(column.defaultExpr);
      if (
        isPrimaryKey &&
        generatesKey &&
        (base.storage === "integer" || base.storage === "bigint")
      ) {
        // A serial or identity key is the builder's server-generated id()/bigid().
        columnPlan.base =
          base.storage === "integer"
            ? { call: "id()", importName: "id", storage: "id" }
            : { call: "bigid()", importName: "bigid", storage: "bigid" };
        if (column.identity !== "d") {
          tableApproximated.push(
            `${qualified(table.name, column.name)}: ${column.identity === "a" ? "GENERATED ALWAYS AS IDENTITY" : "a serial key"} is declared as ${columnPlan.base.call}, an identity generated BY DEFAULT`,
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
          const skip = makeSkip(table.name, column.name, parsed.skip);
          tableSkips.push(skip);
          columnPlan.comments.push(`// appkit: skipped ${skip.reason}`);
          if (column.notNull) {
            tableWarnings.push(
              `${qualified(table.name, column.name)}: its ${parsed.skip.replace(/ is not supported$/, "")} is not in schema.ts, so the API requires a value for it on insert.`,
            );
          }
        }
      }
      plan.columns.push(columnPlan);
      plan.body.push(columnPlan);
    }

    if (!plan.columns.some((c) => c.isPrimaryKey)) {
      plans.delete(table.name);
      skipTable(
        table.name,
        `its primary key column "${pk}" cannot be expressed (${columnReasons.get(pk as string) ?? "unsupported"})`,
      );
      continue;
    }
    skipped.push(...tableSkips);
    warnings.push(...tableWarnings);
    if (table.partitioned) {
      tableApproximated.push(
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
        tableApproximated.push(
          `${qualified(table.name)}: ${names.length === 1 ? `${one} ${names[0]} is` : `${many} ${list(names)} are`} not declared`,
        );
      }
    }
    approximated.push(...tableApproximated);
    renamed.push(...tableRenamed);
  }

  // 3. Foreign keys the builder can express; the rest stay plain columns.
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
  /** Why the builder cannot express this FK; null when it can. */
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
    if (foreignKey.schema !== schemaName) {
      return `it references schema "${foreignKey.schema}"`;
    }
    if (foreignKey.table === plan.table.name) {
      // The builder takes one with a TableHandle annotation, which introspect does not write.
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
    for (const foreignKey of plan.table.foreignKeys) {
      const source = plan.columns.find(
        (c) => c.column.name === foreignKey.columns[0],
      );
      const reason = fkProblem(plan, foreignKey, source, targets);
      if (reason) {
        // A skipped column already carries its own comment.
        if (source || foreignKey.columns.length > 1) {
          const skip = makeSkip(
            plan.table.name,
            foreignKey.columns.join(", "),
            `foreign key to ${foreignKey.table}(${list(foreignKey.refColumns)}) is not kept: ${reason}`,
          );
          skipped.push(skip);
          (source?.comments ?? plan.comments).push(
            `// appkit: skipped ${skip.reason}`,
          );
        }
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
        // fk() takes no defaultRandom()/defaultNow(); the key matters more than the default.
        const skip = makeSkip(
          plan.table.name,
          sourceColumn.column.name,
          `default ${sourceColumn.column.defaultExpr} is not supported on a foreign key column`,
        );
        skipped.push(skip);
        sourceColumn.comments.push(`// appkit: skipped ${skip.reason}`);
        delete sourceColumn.defaultCall;
        if (sourceColumn.column.notNull) {
          warnings.push(
            `${qualified(plan.table.name, sourceColumn.column.name)}: its default ${sourceColumn.column.defaultExpr} is not in schema.ts, so the API requires a value for it on insert.`,
          );
        }
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

  // 4. Declaration order: targets before the tables that reference them.
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

  // 5. Identifiers and imports.
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

  // 6. Source.
  const lines: string[] = [
    `// Generated by \`appkit db introspect\` from schema "${shown(schemaName)}". Edit tables here,`,
    "// then run `npx appkit db migrate` on your dev branch.",
    importLine(
      [...imports].sort(),
      options.importSource ?? "@databricks/appkit/beta",
    ),
    "",
  ];
  // Only a schema other than the default is passed to defineSchema().
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

  // The builder's body, indented one level.
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
