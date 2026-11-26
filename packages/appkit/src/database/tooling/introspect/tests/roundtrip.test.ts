import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, test } from "vitest";

import { loadDefaultDatabaseSchema } from "../../../../plugins/database/load-schema";
import type { Schema } from "../../../schema-builder/types";
import { drizzleKitImports } from "../../drizzle-exports";
import { withHistoryLock } from "../../history-lock";
import { generateMigrationFiles } from "../../migrations";
import type { IntrospectedTable } from "../catalog";
import { renderSchemaSource } from "../render";
import {
  BUILDER,
  col,
  foreignKey,
  richTables,
  tableOf,
  uniqueKey,
} from "./fixture";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

async function loadSource(source: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "appkit-introspect-"));
  roots.push(root);
  const file = path.join(root, "config/database/schema.ts");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
  return { root, schema: await loadDefaultDatabaseSchema(root) };
}

const load = (tables: IntrospectedTable[]) =>
  loadSource(
    renderSchemaSource(tables, "app", { importSource: BUILDER, previous: null })
      .source,
  );

interface KitColumn {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
  default?: unknown;
}
interface KitTable {
  name: string;
  schema: string;
  columns: Record<string, KitColumn>;
  foreignKeys: Record<
    string,
    {
      tableTo: string;
      columnsFrom: string[];
      columnsTo: string[];
      onDelete?: string;
    }
  >;
  uniqueConstraints: Record<string, { columns: string[] }>;
}

interface TableShape {
  columns: Record<string, string>;
  unique: string[][];
  foreignKeys: string[];
  private: string[];
}

async function shape(schema: Schema): Promise<Record<string, TableShape>> {
  const { generateDrizzleJson } = await import("drizzle-kit/api");
  const snapshot = generateDrizzleJson(drizzleKitImports(schema), undefined, [
    schema.$schemaName,
  ]) as unknown as { tables: Record<string, KitTable> };
  return Object.fromEntries(
    Object.values(schema.$tables).map((table): [string, TableShape] => {
      const kit = snapshot.tables[
        `${schema.$schemaName}.${table.$name}`
      ] as KitTable;
      return [
        table.$name,
        {
          columns: Object.fromEntries(
            Object.values(kit.columns).map((c) => [
              c.name,
              `${c.type}${c.notNull ? " not null" : ""}${c.primaryKey ? " pk" : ""}${c.default === undefined ? "" : ` default ${String(c.default)}`}`,
            ]),
          ),
          unique: Object.values(kit.uniqueConstraints).map((u) => u.columns),
          foreignKeys: Object.values(kit.foreignKeys).map(
            (fk) =>
              `${fk.columnsFrom.join(", ")} -> ${fk.tableTo}(${fk.columnsTo.join(", ")})${fk.onDelete && fk.onDelete !== "no action" ? ` on delete ${fk.onDelete}` : ""}`,
          ),
          private: Object.values(table.$columns)
            .filter((c) => c.isPrivate)
            .map((c) => c.columnName),
        },
      ];
    }),
  );
}

describe("introspect round trip", () => {
  test("the rendered source loads through loadDefaultDatabaseSchema, and drizzle-kit sees the same tables", async () => {
    const { schema } = await load(richTables);
    expect(schema.$schemaName).toBe("app");
    expect(Object.keys(schema.$tables).sort()).toEqual([
      "authors",
      "default",
      "posts",
    ]);

    const { generateDrizzleJson } = await import("drizzle-kit/api");
    const snapshot = generateDrizzleJson(drizzleKitImports(schema), undefined, [
      "app",
    ]) as unknown as {
      tables: Record<string, KitTable>;
      enums: Record<string, { name: string; schema: string; values: string[] }>;
    };
    const columns = (table: string) =>
      Object.fromEntries(
        Object.values(snapshot.tables[`app.${table}`]?.columns ?? {}).map(
          (c) => [
            c.name,
            `${c.type}${c.notNull ? " not null" : ""}${c.primaryKey ? " pk" : ""}`,
          ],
        ),
      );

    expect(columns("authors")).toEqual({
      id: "integer not null pk",
      email: "varchar(255) not null",
      bio: "text",
      active: "boolean not null",
      rank: "integer",
      created_at: "timestamp with time zone not null",
      seen_at: "timestamp",
    });
    expect(columns("posts")).toEqual({
      id: "uuid not null pk",
      author_id: "integer not null",
      editor_id: "integer",
      status: "ticket_status not null",
      body: "jsonb",
      views: "bigint not null",
      "my col": "text",
    });
    expect(columns("default")).toEqual({ id: "bigint not null pk" });
    expect(
      Object.values(snapshot.tables["app.posts"]?.foreignKeys ?? {}),
    ).toEqual([
      expect.objectContaining({
        tableTo: "authors",
        columnsFrom: ["author_id"],
        columnsTo: ["id"],
        onDelete: "cascade",
      }),
    ]);
    expect(snapshot.enums["app.ticket_status"]).toMatchObject({
      values: ["open", "closed"],
    });
  });

  test("the baseline is generated from the empty snapshot: it creates every rendered table", async () => {
    const { root, schema } = await load(richTables);
    const migration = await withHistoryLock(root, "migrate", (lock) =>
      generateMigrationFiles(lock, {
        schema,
        tag: "baseline",
        interactive: false,
      }),
    );

    expect(migration?.tag).toBe("0000_baseline");
    const sql = migration?.statements.join("\n") ?? "";
    for (const table of ["authors", "posts", "default"]) {
      expect(sql).toContain(`CREATE TABLE "app"."${table}"`);
    }
    expect(sql).toContain(
      `CREATE TYPE "app"."ticket_status" AS ENUM('open', 'closed')`,
    );
    expect(sql).not.toContain("CREATE SCHEMA");
  });

  test("every skip path still yields a loadable schema", async () => {
    const tables: IntrospectedTable[] = [
      tableOf({
        name: "a",
        primaryKey: ["id"],
        unique: [uniqueKey("a", "x", "y")],
        foreignKeys: [
          foreignKey({
            name: "self",
            columns: ["parent_id"],
            schema: "app",
            table: "a",
            refColumns: ["id"],
            onDelete: "no action",
            onUpdate: "no action",
          }),
          foreignKey({
            name: "to_b",
            columns: ["b_id"],
            schema: "app",
            table: "b",
            refColumns: ["id"],
            onDelete: "set null",
            onUpdate: "no action",
          }),
        ],
        columns: [
          col("id", "integer", { notNull: true, identity: "a" }),
          col("parent_id", "integer"),
          col("b_id", "integer", { notNull: true }),
          col("x", "integer"),
          col("y", "integer"),
          col("g", "integer", { generated: true, defaultExpr: "(x + y)" }),
          col("seq", "integer", { identity: "d" }),
          col("tags", "text[]"),
          col("mood", "app.mood", {
            enum: { name: "mood", schema: "app", values: ["", "ok"] },
          }),
        ],
      }),
      tableOf({
        name: "b",
        primaryKey: ["id"],
        unique: [],
        foreignKeys: [
          foreignKey({
            name: "to_a",
            columns: ["a_id"],
            schema: "app",
            table: "a",
            refColumns: ["id"],
            onDelete: "no action",
            onUpdate: "no action",
          }),
        ],
        columns: [
          col("id", "integer", { notNull: true, identity: "d" }),
          col("a_id", "integer"),
        ],
      }),
    ];
    const { schema } = await load(tables);
    expect(Object.keys(schema.$tables).sort()).toEqual(["a", "b"]);
    expect(Object.keys(schema.$tables.a?.$columns ?? {})).toEqual([
      "id",
      "parent_id",
      "b_id",
      "x",
      "y",
    ]);
  });

  test("a uuid FK with gen_random_uuid() and names with line breaks still load, with no extra code", async () => {
    const marker = "__introspect_injected__";
    const { schema } = await load([
      tableOf({
        name: "u",
        primaryKey: ["id"],
        columns: [
          col("id", "uuid", {
            notNull: true,
            defaultExpr: "gen_random_uuid()",
          }),
        ],
      }),
      tableOf({
        name: "t",
        primaryKey: ["id"],
        foreignKeys: [
          foreignKey({
            name: "t_u_id_fkey",
            columns: ["u_id"],
            schema: "app",
            table: "u",
            refColumns: ["id"],
            onDelete: "no action",
            onUpdate: "no action",
          }),
        ],
        columns: [
          col("id", "integer", { notNull: true, identity: "d" }),
          col("u_id", "uuid", {
            notNull: true,
            defaultExpr: "gen_random_uuid()",
          }),
          col(`x\nglobalThis.${marker} = true; //`, "numeric"),
          col(`y\u2028globalThis.${marker} = true; //`, "numeric"),
        ],
      }),
    ]);

    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
    expect(Object.keys(schema.$tables).sort()).toEqual(["t", "u"]);
    expect(Object.keys(schema.$tables.t?.$columns ?? {})).toEqual([
      "id",
      "u_id",
    ]);
  });

  test("hostile names reach every place render writes them and load back unchanged, with no code run", async () => {
    const marker = "__introspect_hostile__";
    const payload = `globalThis.${marker} = true; //`;
    const [
      lf,
      cr,
      ls,
      ps,
      quote,
      apostrophe,
      backslash,
      backtick,
      bidi,
      close,
    ] = [
      `lf\n${payload}`,
      `cr\r${payload}`,
      `ls\u2028${payload}`,
      `ps\u2029${payload}`,
      `q"]; ${payload}`,
      `s'); ${payload}`,
      `b\\"; ${payload}`,
      `t\`\${globalThis.${marker} = true}\``,
      "bidi\u202e\u2066x",
      `*/ ${payload}`,
    ];
    const texts = [lf, cr, ls, ps, apostrophe, backslash, backtick, bidi];
    const literal = (value: string) => `'${value.replace(/'/g, "''")}'::text`;
    const kind = { name: close, schema: "app", values: [quote, cr, bidi] };
    const level = { name: "level", schema: "app", values: [ls, bidi] };
    const tables = [
      tableOf({
        name: "target",
        primaryKey: [quote],
        columns: [col(quote, "integer", { notNull: true, identity: "d" })],
      }),
      tableOf({
        name: "source",
        primaryKey: ["id"],
        foreignKeys: [
          foreignKey({
            name: apostrophe,
            columns: [backslash],
            schema: "app",
            table: "target",
            refColumns: [quote],
            onDelete: "no action",
            onUpdate: "no action",
          }),
        ],
        columns: [
          col("id", "integer", { notNull: true, identity: "d" }),
          col(backslash, "integer", { notNull: true }),
          ...texts.map((name) =>
            col(`c ${name}`, "text", { defaultExpr: literal(name) }),
          ),
          col("kind", `app."${close}"`, { enum: kind }),
          col("level", "app.level", {
            defaultExpr: `'${bidi}'::app.level`,
            enum: level,
          }),
          ...[lf, cr, ls, ps].map((name) => col(`skipped ${name}`, "numeric")),
        ],
      }),
      tableOf({
        name: close,
        primaryKey: ["id"],
        columns: [col("id", "integer", { notNull: true, identity: "d" })],
      }),
      tableOf({ name: ps, columns: [col(cr, "text")] }),
    ];

    const { schema } = await load(tables);

    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
    expect(Object.keys(schema.$tables).sort()).toEqual(
      ["source", "target", close].sort(),
    );
    const config = (name: string) =>
      getTableConfig(schema.$engine[name] as unknown as PgTable);
    expect(config(close).name).toBe(close);
    expect(config("target").columns.map((c) => c.name)).toEqual([quote]);
    const source = config("source");
    expect(source.columns.map((c) => c.name)).toEqual([
      "id",
      backslash,
      ...texts.map((name) => `c ${name}`),
      "kind",
      "level",
    ]);
    const column = (name: string) =>
      source.columns.find((c) => c.name === name);
    for (const name of texts) expect(column(`c ${name}`)?.default).toBe(name);
    expect(
      (column("kind") as unknown as { enum: { enumName: string } }).enum
        .enumName,
    ).toBe(close);
    expect(column("kind")?.enumValues).toEqual(kind.values);
    expect(column("level")?.enumValues).toEqual(level.values);
    expect(column("level")?.default).toBe(bidi);
    expect(
      source.foreignKeys.map((fk) =>
        fk.reference().foreignColumns.map((c) => c.name),
      ),
    ).toEqual([[quote]]);
  });

  test("a refresh over the schema.ts it replaces keeps what it declares, and adds the rest as the catalog has it", async () => {
    const before =
      await loadSource(`import { defineSchema, fk, id, text, timestamp } from ${JSON.stringify(BUILDER)};
export const schema = defineSchema(({ table }) => {
  const boards = table("boards", {
    id: id(),
    title: text().notNull(),
    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  });
  const notes = table("notes", {
    id: id(),
    board_id: fk(() => boards.id).notNull().onDelete("cascade"),
    slug: text().unique(),
    author_email: text().private(),
    body: text().notNull().default("-"),
  });
  return { boards, notes };
});
`);
    const key = col("id", "integer", { notNull: true, identity: "d" });
    const catalog = [
      tableOf({
        name: "boards",
        primaryKey: ["id"],
        columns: [
          key,
          col("title", "text", { notNull: true }),
          col("created_at", "timestamp with time zone", {
            notNull: true,
            defaultExpr: "now()",
          }),
        ],
      }),
      tableOf({
        name: "notes",
        primaryKey: ["id"],
        unique: [
          { name: "notes_slug_unique", columns: ["slug"], deferrable: false },
        ],
        foreignKeys: [
          foreignKey({
            name: "notes_board_id_boards_id_fk",
            columns: ["board_id"],
            schema: "app",
            table: "boards",
            refColumns: ["id"],
            onDelete: "cascade",
            onUpdate: "no action",
          }),
          foreignKey({
            name: "notes_reviewer_id_reviewers_id_fk",
            columns: ["reviewer_id"],
            schema: "app",
            table: "reviewers",
            refColumns: ["id"],
            onDelete: "no action",
            onUpdate: "no action",
          }),
        ],
        columns: [
          key,
          col("board_id", "integer", { notNull: true }),
          col("slug", "text"),
          col("author_email", "text"),
          col("body", "text", { notNull: true, defaultExpr: "'-'::text" }),
          col("summary", "text"),
          col("reviewer_id", "integer"),
        ],
      }),
      tableOf({
        name: "reviewers",
        primaryKey: ["id"],
        columns: [key, col("label", "text")],
      }),
    ];

    const rendered = renderSchemaSource(catalog, "app", {
      importSource: BUILDER,
      previous: before.schema,
    });
    const after = await loadSource(rendered.source);
    const was = await shape(before.schema);
    const is = await shape(after.schema);

    expect(was).toEqual({
      boards: {
        columns: {
          id: "integer not null pk",
          title: "text not null",
          created_at: "timestamp with time zone not null default now()",
        },
        unique: [],
        foreignKeys: [],
        private: [],
      },
      notes: {
        columns: {
          id: "integer not null pk",
          board_id: "integer not null",
          slug: "text",
          author_email: "text",
          body: "text not null default '-'",
        },
        unique: [["slug"]],
        foreignKeys: ["board_id -> boards(id) on delete cascade"],
        private: ["author_email"],
      },
    });
    for (const [table, declared] of Object.entries(was)) {
      const kept = is[table] as TableShape;
      expect(kept.columns).toMatchObject(declared.columns);
      expect(kept.unique).toEqual(expect.arrayContaining(declared.unique));
      expect(kept.foreignKeys).toEqual(
        expect.arrayContaining(declared.foreignKeys),
      );
      expect(kept.private).toEqual(declared.private);
    }
    expect(is.notes).toMatchObject({
      columns: { summary: "text", reviewer_id: "integer" },
      foreignKeys: [
        "board_id -> boards(id) on delete cascade",
        "reviewer_id -> reviewers(id)",
      ],
    });
    expect(is.reviewers).toEqual({
      columns: { id: "integer not null pk", label: "text" },
      unique: [],
      foreignKeys: [],
      private: [],
    });
  });
});
