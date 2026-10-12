import path from "node:path";

import type {
  CatalogQuery,
  ColumnRow,
  ConstraintRow,
  IndexRow,
  IntrospectedColumn,
  IntrospectedForeignKey,
  IntrospectedTable,
  IntrospectedUnique,
  TableRow,
} from "../catalog";

/** The builder by absolute path, so rendered sources load from a temp root. */
export const BUILDER = path.resolve(
  import.meta.dirname,
  "../../../schema-builder/index.ts",
);

export const col = (
  name: string,
  type: string,
  extra: Partial<IntrospectedColumn> = {},
): IntrospectedColumn => ({
  name,
  type,
  notNull: false,
  identity: "",
  generated: false,
  defaultExpr: null,
  ...extra,
});

/** A catalog table; what a test does not set is empty. */
export const tableOf = (
  table: Pick<IntrospectedTable, "name" | "columns"> &
    Partial<IntrospectedTable>,
): IntrospectedTable => ({
  partitioned: false,
  primaryKey: [],
  unique: [],
  foreignKeys: [],
  checks: [],
  indexes: [],
  ...table,
});

export const foreignKey = (
  key: Omit<IntrospectedForeignKey, "deferrable" | "matchFull"> &
    Partial<IntrospectedForeignKey>,
): IntrospectedForeignKey => ({ deferrable: false, matchFull: false, ...key });

/** A unique constraint with the name Postgres gives it. */
export const uniqueKey = (
  table: string,
  ...columns: string[]
): IntrospectedUnique => ({
  name: `${table}_${columns.join("_")}_key`,
  columns,
});

const status = {
  name: "ticket_status",
  schema: "app",
  values: ["open", "closed"],
};

/** Supported types, defaults, FKs and enums, plus one of each skip. Listed out of dependency order. */
export const richTables: IntrospectedTable[] = [
  tableOf({
    name: "posts",
    primaryKey: ["id"],
    unique: [],
    foreignKeys: [
      foreignKey({
        name: "posts_author_id_fkey",
        columns: ["author_id"],
        schema: "app",
        table: "authors",
        refColumns: ["id"],
        onDelete: "cascade",
        onUpdate: "no action",
      }),
      foreignKey({
        name: "posts_editor_id_fkey",
        columns: ["editor_id"],
        schema: "app",
        table: "authors",
        refColumns: ["id"],
        onDelete: "set null",
        onUpdate: "no action",
      }),
    ],
    columns: [
      col("id", "uuid", { notNull: true, defaultExpr: "gen_random_uuid()" }),
      col("author_id", "integer", { notNull: true }),
      col("editor_id", "integer"),
      col("status", "app.ticket_status", {
        notNull: true,
        defaultExpr: "'open'::app.ticket_status",
        enum: status,
      }),
      col("body", "jsonb", { defaultExpr: "'{}'::jsonb" }),
      col("views", "bigint", { notNull: true, defaultExpr: "0" }),
      col("my col", "character varying"),
    ],
  }),
  tableOf({
    name: "authors",
    primaryKey: ["id"],
    unique: [uniqueKey("authors", "email")],
    foreignKeys: [],
    columns: [
      col("id", "integer", {
        notNull: true,
        defaultExpr: "nextval('app.authors_id_seq'::regclass)",
      }),
      col("email", "character varying(255)", { notNull: true }),
      col("bio", "text", { defaultExpr: "'it''s me'::text" }),
      col("active", "boolean", { notNull: true, defaultExpr: "true" }),
      col("score", "numeric(10,2)", { notNull: true }),
      col("rank", "integer", { defaultExpr: "'-1'::integer" }),
      col("created_at", "timestamp with time zone", {
        notNull: true,
        defaultExpr: "now()",
      }),
      col("seen_at", "timestamp(3) without time zone"),
    ],
  }),
  tableOf({
    name: "events",
    primaryKey: ["a", "b"],
    unique: [],
    foreignKeys: [],
    columns: [
      col("a", "integer", { notNull: true }),
      col("b", "integer", { notNull: true }),
    ],
  }),
  tableOf({
    name: "logs",
    primaryKey: [],
    unique: [],
    foreignKeys: [],
    columns: [col("line", "text")],
  }),
  tableOf({
    name: "default",
    primaryKey: ["id"],
    unique: [],
    foreignKeys: [],
    columns: [col("id", "bigint", { notNull: true, identity: "d" })],
  }),
];

export const columnRow = (
  table_name: string,
  name: string,
  type: string,
  extra: Partial<ColumnRow> = {},
): ColumnRow => ({
  table_name,
  name,
  type,
  not_null: false,
  identity: "",
  generated: "",
  default_expr: null,
  type_kind: "b",
  type_schema: "pg_catalog",
  type_name: type,
  enum_values: null,
  ...extra,
});

/** What the three pg_catalog queries return for a small hand-made schema. */
export const catalogRows = {
  tables: [
    { name: "authors", partitioned: false },
    { name: "posts", partitioned: false },
  ] satisfies TableRow[],
  columns: [
    columnRow("authors", "id", "integer", {
      not_null: true,
      default_expr: "nextval('app.authors_id_seq'::regclass)",
    }),
    columnRow("authors", "email", "character varying(255)", {
      not_null: true,
    }),
    columnRow("authors", "created_at", "timestamp with time zone", {
      not_null: true,
      default_expr: "now()",
    }),
    columnRow("posts", "id", "integer", { not_null: true, identity: "d" }),
    columnRow("posts", "author_id", "integer", { not_null: true }),
    columnRow("posts", "status", "app.ticket_status", {
      not_null: true,
      default_expr: "'open'::app.ticket_status",
      type_kind: "e",
      type_schema: "app",
      type_name: "ticket_status",
      enum_values: ["open", "closed"],
    }),
    columnRow("posts", "score", "numeric(10,2)", { not_null: true }),
    columnRow("posts", "total", "integer", {
      generated: "s",
      default_expr: "1",
    }),
  ] satisfies ColumnRow[],
  constraints: [
    {
      table_name: "authors",
      name: "authors_email_key",
      kind: "u",
      columns: ["email"],
      ref_schema: null,
      ref_table: null,
      ref_columns: [],
      on_delete: " ",
      on_update: " ",
    },
    {
      table_name: "authors",
      name: "authors_pkey",
      kind: "p",
      columns: ["id"],
      ref_schema: null,
      ref_table: null,
      ref_columns: [],
      on_delete: " ",
      on_update: " ",
    },
    {
      table_name: "posts",
      name: "posts_author_id_fkey",
      kind: "f",
      columns: ["author_id"],
      ref_schema: "app",
      ref_table: "authors",
      ref_columns: ["id"],
      on_delete: "c",
      on_update: "a",
    },
    {
      table_name: "posts",
      name: "posts_pkey",
      kind: "p",
      columns: ["id"],
      ref_schema: null,
      ref_table: null,
      ref_columns: [],
      on_delete: " ",
      on_update: " ",
    },
  ] satisfies ConstraintRow[],
  indexes: [
    { table_name: "posts", name: "posts_status_idx" },
  ] satisfies IndexRow[],
};

/** A CatalogQuery answering the catalog queries from rows, and the unread-objects query from labels. */
export function catalogResponder(
  rows: {
    readonly tables: readonly TableRow[];
    readonly columns: readonly ColumnRow[];
    readonly constraints: readonly ConstraintRow[];
    readonly indexes: readonly IndexRow[];
  } = catalogRows,
  unread: readonly string[] = [],
) {
  const calls: Array<{ text: string; values: readonly unknown[] }> = [];
  const respond: CatalogQuery = async <T>(
    text: string,
    values: readonly unknown[],
  ) => {
    calls.push({ text, values });
    // The unread and index queries mention what the others match on, so they go first.
    const result = text.includes("pg_catalog.pg_depend")
      ? unread.map((label) => ({ label }))
      : text.includes("pg_catalog.pg_index")
        ? rows.indexes
        : text.includes("pg_catalog.pg_constraint")
          ? rows.constraints
          : text.includes("format_type")
            ? rows.columns
            : text.includes("select c.relname::text as name")
              ? rows.tables
              : [];
    return result as unknown as T[];
  };
  return { calls, respond };
}
