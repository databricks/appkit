import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import type { IntrospectedForeignKey, IntrospectedTable } from "../catalog";
import { renderSchemaSource } from "../render";
import { col, richTables, tableOf, uniqueKey } from "./fixture";

const golden = (name: string) =>
  fs.readFileSync(path.join(import.meta.dirname, "golden", name), "utf-8");

const fk = (
  column: string,
  table: string,
  extra: Partial<IntrospectedForeignKey> = {},
): IntrospectedForeignKey => ({
  name: `${column}_fkey`,
  columns: [column],
  schema: "app",
  table,
  refColumns: ["id"],
  onDelete: "no action",
  onUpdate: "no action",
  deferrable: false,
  matchFull: false,
  ...extra,
});

/** A table with an integer identity key plus the given columns and FKs. */
const keyed = (
  name: string,
  columns: IntrospectedTable["columns"] = [],
  foreignKeys: IntrospectedForeignKey[] = [],
  unique: string[][] = [],
): IntrospectedTable =>
  tableOf({
    name,
    primaryKey: ["id"],
    unique: unique.map((columns) => uniqueKey(name, ...columns)),
    foreignKeys,
    columns: [
      col("id", "integer", { notNull: true, identity: "d" }),
      ...columns,
    ],
  });

const body = (source: string) =>
  source.slice(source.indexOf("export const schema"));

describe("renderSchemaSource", () => {
  test("golden: supported types, defaults, FKs and enums, with skip comments", () => {
    const out = renderSchemaSource(richTables, "app");

    expect(out.source).toBe(golden("rich.schema.ts.txt"));
    expect(out.skipped).toEqual(
      expect.arrayContaining([
        {
          table: "events",
          reason: "composite primary key (a, b) is not supported",
        },
        { table: "logs", reason: "it has no primary key" },
        {
          table: "authors",
          column: "score",
          reason: 'type "numeric(10,2)" is not supported',
        },
        {
          table: "posts",
          column: "body",
          reason: "default '{}'::jsonb is not supported",
        },
        {
          table: "posts",
          column: "views",
          reason: "default 0 is not supported",
        },
        {
          table: "posts",
          column: "editor_id",
          reason:
            'foreign key to authors(id) is not kept: a second foreign key to "authors" would make the relation ambiguous',
        },
      ]),
    );
    expect(out.skipped).toHaveLength(6);
  });

  test("a skipped NOT NULL column without a default is a loud warning", () => {
    const { warnings } = renderSchemaSource(richTables, "app");
    expect(warnings).toContain(
      'app.authors.score is NOT NULL with no default but is not in schema.ts (type "numeric(10,2)" is not supported). Inserts through the API will fail until it gets a default, becomes nullable, or is dropped.',
    );
    expect(warnings).toContain(
      "app.posts.views: its default 0 is not in schema.ts, so the API requires a value for it on insert.",
    );
    expect(
      warnings.filter((warning) => !warning.startsWith("Constraint names")),
    ).toHaveLength(2);
  });

  test.each([
    ["app", "export const schema = defineSchema(() => ({}));\n"],
    [
      "public",
      'export const schema = defineSchema(() => ({}), { schemaName: "public" });\n',
    ],
  ])(
    "no tables in %s renders an empty schema, naming the schema only when it is not app",
    (schemaName, expected) => {
      expect(body(renderSchemaSource([], schemaName).source)).toBe(expected);
    },
  );

  test("tables in a schema other than app pass it to defineSchema", () => {
    expect(body(renderSchemaSource([keyed("notes")], "public").source)).toBe(
      [
        "export const schema = defineSchema(",
        "  ({ table }) => {",
        '    const notes = table("notes", {',
        "      id: id(),",
        "    });",
        "",
        "    return { notes };",
        "  },",
        '  { schemaName: "public" },',
        ");",
        "",
      ].join("\n"),
    );
  });

  test("declares FK targets first, whatever the catalog order", () => {
    const { source } = renderSchemaSource(
      [
        keyed("c", [col("b_id", "integer")], [fk("b_id", "b")]),
        keyed("b", [col("a_id", "integer")], [fk("a_id", "a")]),
        keyed("a"),
      ],
      "app",
    );
    const order = ["a", "b", "c"].map((name) =>
      source.indexOf(`const ${name} = table`),
    );
    expect(order).toEqual([...order].sort((x, y) => x - y));
    expect(source).toContain("return { a, b, c };");
  });

  test("FKs the builder cannot express stay plain columns, each with its reason", () => {
    const cases: Array<[IntrospectedTable[], string]> = [
      [
        [keyed("t", [col("parent_id", "integer")], [fk("parent_id", "t")])],
        "introspect does not write self-references",
      ],
      [
        [
          keyed("a", [col("b_id", "integer")], [fk("b_id", "b")]),
          keyed("b", [col("a_id", "integer")], [fk("a_id", "a")]),
        ],
        "it would close a cycle of foreign keys",
      ],
      [
        [
          keyed(
            "t",
            [col("x", "integer"), col("y", "integer")],
            [{ ...fk("x", "u"), columns: ["x", "y"], refColumns: ["id", "k"] }],
          ),
          keyed("u"),
        ],
        "foreign keys over several columns are not supported",
      ],
      [
        [
          keyed(
            "t",
            [col("u_id", "integer")],
            [fk("u_id", "u", { schema: "public" })],
          ),
          keyed("u"),
        ],
        'it references schema "public"',
      ],
      [
        [
          keyed(
            "t",
            [col("u_code", "integer")],
            [fk("u_code", "u", { refColumns: ["code"] })],
          ),
          keyed("u", [col("code", "integer")]),
        ],
        "u.code is not a primary key or single-column unique key",
      ],
      [
        [keyed("t", [col("u_id", "bigint")], [fk("u_id", "u")]), keyed("u")],
        "its type bigint() differs from u.id",
      ],
      [
        [
          keyed(
            "t",
            [col("u_id", "integer", { notNull: true })],
            [fk("u_id", "u", { onDelete: "set null" })],
          ),
          keyed("u"),
        ],
        "SET NULL on a NOT NULL column",
      ],
      [
        [
          keyed(
            "t",
            [col("u_id", "integer")],
            [fk("u_id", "u", { onDelete: "set default" })],
          ),
          keyed("u"),
        ],
        "SET DEFAULT without a default",
      ],
      [
        [
          keyed(
            "t",
            [col("u_id", "integer"), col("u", "text")],
            [fk("u_id", "u")],
          ),
          keyed("u"),
        ],
        'the relation "u" would clash with the column of the same name',
      ],
      [
        [
          keyed("t", [col("u_id", "integer")], [fk("u_id", "u")]),
          keyed("u", [col("t", "text")]),
        ],
        'the reverse relation "t" would clash with column u.t',
      ],
      [
        [
          keyed("t", [col("u_id", "integer")], [fk("u_id", "u")]),
          { ...keyed("u"), primaryKey: ["id", "x"] },
        ],
        'table "u" is skipped',
      ],
    ];
    for (const [tables, reason] of cases) {
      const out = renderSchemaSource(tables, "app");
      expect(out.source, reason).toContain(reason);
      const fkSkips = out.skipped.filter((skip) =>
        skip.reason.startsWith("foreign key"),
      );
      expect(fkSkips, reason).toHaveLength(1);
      // Exactly one fk() survives only in the cycle case (the first edge).
      expect(out.source.includes("fk(() =>"), reason).toBe(
        reason.includes("cycle"),
      );
    }
  });

  test("an FK keeps NOT NULL, unique, a default and its actions", () => {
    const { source } = renderSchemaSource(
      [
        keyed(
          "t",
          [col("u_id", "integer", { notNull: true, defaultExpr: "1" })],
          [fk("u_id", "u", { onDelete: "set default", onUpdate: "cascade" })],
          [["u_id"]],
        ),
        keyed("u"),
      ],
      "app",
    );
    expect(source).toContain(
      'u_id: fk(() => u.id).notNull().unique().default(1).onDelete("set default").onUpdate("cascade"),',
    );
  });

  test("a table whose primary key cannot be expressed is skipped whole", () => {
    const out = renderSchemaSource(
      [
        tableOf({
          name: "t",
          primaryKey: ["code"],
          unique: [],
          foreignKeys: [],
          columns: [
            col("code", "smallint", { notNull: true }),
            col("x", "numeric", { notNull: true }),
          ],
        }),
      ],
      "app",
    );
    expect(out.skipped).toEqual([
      {
        table: "t",
        reason:
          'its primary key column "code" cannot be expressed (type "smallint" is not supported)',
      },
    ]);
    // The table is gone, so its columns produce no warnings.
    expect(out.warnings).toEqual([]);
  });

  test("names AppKit reserves are skipped; unusual names are quoted or renamed", () => {
    const out = renderSchemaSource(
      [
        keyed("sql"),
        keyed("my-table", [
          col("$meta", "text"),
          col("and", "text"),
          col("select", "text"),
        ]),
        keyed("users"),
        keyed("usersRelations"),
      ],
      "app",
    );
    expect(
      out.skipped.map((skip) => [skip.table, skip.column ?? null, skip.reason]),
    ).toEqual([
      ["sql", null, 'the name "sql" is reserved by AppKit'],
      [
        "usersRelations",
        null,
        'the name collides with the relation metadata AppKit generates for "users"',
      ],
      ["my-table", "$meta", 'the name "$meta" is reserved by AppKit'],
      ["my-table", "and", 'the name "and" is reserved by AppKit'],
    ]);
    expect(out.source).toContain('const my_table = table("my-table", {');
    expect(out.source).toContain("    select: text(),");
    expect(out.source).toContain('return { "my-table": my_table, users };');
  });

  test("unsupported defaults are dropped with a comment; nextval on a key becomes id()", () => {
    const { source, skipped } = renderSchemaSource(
      [
        tableOf({
          name: "t",
          primaryKey: ["id"],
          unique: [],
          foreignKeys: [],
          columns: [
            col("id", "bigint", {
              notNull: true,
              defaultExpr: "nextval('t_id_seq'::regclass)",
            }),
            col("code", "character varying(2)", {
              defaultExpr: "'toolong'::character varying",
            }),
            col("at", "timestamp without time zone", {
              defaultExpr: "'2020-01-01 00:00:00'::timestamp without time zone",
            }),
            col("n", "integer", { defaultExpr: "nextval('n_seq'::regclass)" }),
          ],
        }),
      ],
      "app",
    );
    expect(source).toContain("    id: bigid(),");
    expect(skipped.map((skip) => skip.column)).toEqual(["code", "at", "n"]);
    expect(source).toContain("    code: varchar(2),");
  });

  test("a catalog name with a line break stays inside its comment", () => {
    const evil = "x\nrequire('node:child_process').execSync('touch /tmp/p')//";
    const { source, skipped, warnings } = renderSchemaSource(
      [
        keyed("t", [
          col(evil, "numeric", { notNull: true }),
          col("y\u2028z", "numeric"),
        ]),
      ],
      "app",
    );
    for (const line of source.split("\n")) {
      expect(line.trimStart().startsWith("require(")).toBe(false);
    }
    expect(source).not.toMatch(/[\u2028\u2029]/);
    expect(source).toContain(
      `// appkit: skipped column "x\\u000arequire('node:child_process').execSync('touch /tmp/p')//": type "numeric" is not supported`,
    );
    expect(source).toContain(
      '// appkit: skipped column "y\\u2028z": type "numeric" is not supported',
    );
    expect(skipped.map((skip) => skip.column)).toEqual([
      "x\\u000arequire('node:child_process').execSync('touch /tmp/p')//",
      "y\\u2028z",
    ]);
    expect(warnings[0]).toMatch(/^app\.t\.x\\u000arequire/);
  });

  test("the schema name in the header comment is escaped too", () => {
    const { source } = renderSchemaSource([keyed("t")], "a\nb");
    expect(source.split("\n")[0]).toBe(
      '// Generated by `appkit db introspect` from schema "a\\u000ab". Edit tables here,',
    );
    expect(source).toContain('{ schemaName: "a\\nb" }');
  });

  test("returns the tables it wrote", () => {
    expect(renderSchemaSource(richTables, "app").tables).toEqual([
      "authors",
      "posts",
      "default",
    ]);
  });

  test("what schema.ts declares differently from the database is listed as approximated", () => {
    const { approximated } = renderSchemaSource(
      [
        tableOf({
          name: "a",
          partitioned: true,
          primaryKey: ["id"],
          checks: ["a_n_check"],
          indexes: ["a_n_idx", "a_m_idx"],
          columns: [
            col("id", "integer", { notNull: true, identity: "a" }),
            col("n", "character varying"),
            col("at", "timestamp(3) with time zone"),
          ],
        }),
        keyed(
          "b",
          [col("a_id", "integer")],
          [
            fk("a_id", "a", {
              name: "b_a_id_a_id_fk",
              deferrable: true,
              matchFull: true,
            }),
          ],
        ),
      ],
      "app",
    );
    expect(approximated).toEqual([
      "app.a.id: GENERATED ALWAYS AS IDENTITY is declared as id(), an identity generated BY DEFAULT",
      "app.a.n: character varying without a length is declared as text()",
      "app.a.at: timestamp(3) with time zone is declared without its precision",
      "app.a: a partitioned table is declared as a plain table",
      "app.a: CHECK or EXCLUDE constraint a_n_check is not declared",
      "app.a: indexes a_n_idx, a_m_idx are not declared",
      "app.b.a_id: the foreign key is declared without DEFERRABLE",
      "app.b.a_id: the foreign key is declared without MATCH FULL",
    ]);
  });

  test("constraint names that differ from the ones migrations use are one warning", () => {
    const { warnings } = renderSchemaSource(richTables, "app");
    expect(warnings).toContain(
      "Constraint names differ from the ones migrations use: authors_email_key (authors_email_unique), posts_author_id_fkey (posts_author_id_authors_id_fk). A later migration that drops or changes one of them fails until it is renamed in the database (ALTER TABLE … RENAME CONSTRAINT).",
    );
  });

  test("constraint names migrations would use raise no warning", () => {
    const { warnings } = renderSchemaSource(
      [
        tableOf({
          ...keyed("u", [col("email", "text")]),
          unique: [{ name: "u_email_unique", columns: ["email"] }],
        }),
        keyed(
          "t",
          [col("u_id", "integer")],
          [fk("u_id", "u", { name: "t_u_id_u_id_fk" })],
        ),
      ],
      "app",
    );
    expect(warnings).toEqual([]);
  });

  test("migrations' constraint names are cut at 63 bytes, as Postgres cuts them", () => {
    const column = "ç".repeat(40);
    const { warnings } = renderSchemaSource(
      [
        tableOf({
          ...keyed("t", [col(column, "text")]),
          // "t_" plus 30 two-byte characters is 62 bytes; one more would pass 63.
          unique: [{ name: `t_${"ç".repeat(30)}`, columns: [column] }],
        }),
      ],
      "app",
    );
    expect(warnings).toEqual([]);
  });

  test("bidi and line-separator characters are escaped in string literals", () => {
    const name = "t\u202e\u2066\u2028x";
    const { source } = renderSchemaSource([keyed(name)], "app");
    expect(source).not.toMatch(/[\u2028\u202e\u2066]/);
    expect(source).toContain('table("t\\u202e\\u2066\\u2028x", {');
  });

  test("what schema.ts leaves out is listed by raw name, for the drop check", () => {
    const status = { name: "status", schema: "app", values: ["a"] };
    const { unexpressed } = renderSchemaSource(
      [
        keyed(
          "t",
          [
            col("n", "numeric"),
            col("s", "app.status", { generated: true, enum: status }),
            col("d", "text", { defaultExpr: "lower('X')" }),
            col("x", "integer"),
            col("y", "integer"),
            col("p", "integer"),
          ],
          [fk("p", "t")],
          [["x", "y"]],
        ),
        tableOf({ name: "logs", columns: [col("line", "text")] }),
      ],
      "app",
    );
    expect(unexpressed).toEqual([
      { kind: "table", name: "logs", reason: "it has no primary key" },
      {
        kind: "constraint",
        name: "t",
        member: "t_x_y_key",
        reason:
          "unique constraint (x, y) spans several columns, which is not supported",
      },
      {
        kind: "column",
        name: "t",
        member: "n",
        reason: 'type "numeric" is not supported',
      },
      {
        kind: "column",
        name: "t",
        member: "s",
        reason: "generated columns are not supported",
      },
      {
        kind: "default",
        name: "t",
        member: "d",
        reason: "default lower('X') is not supported",
      },
      ...["p_fkey", "t_p_t_id_fk"].map((member) => ({
        kind: "constraint",
        name: "t",
        member,
        reason:
          "foreign key to t(id) is not kept: introspect does not write self-references",
      })),
      {
        kind: "type",
        name: "status",
        reason: "only what schema.ts leaves out uses it",
      },
    ]);
  });

  test("a uuid FK keeps the key and skips gen_random_uuid(), which fk() does not take", () => {
    const { source, skipped, warnings } = renderSchemaSource(
      [
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
        keyed(
          "t",
          [
            col("u_id", "uuid", {
              notNull: true,
              defaultExpr: "gen_random_uuid()",
            }),
          ],
          [fk("u_id", "u", { name: "t_u_id_u_id_fk" })],
        ),
      ],
      "app",
    );
    expect(source).toContain("    u_id: fk(() => u.id).notNull(),");
    expect(source).not.toContain("fk(() => u.id).notNull().defaultRandom()");
    expect(skipped).toEqual([
      {
        table: "t",
        column: "u_id",
        reason:
          "default gen_random_uuid() is not supported on a foreign key column",
      },
    ]);
    expect(warnings).toEqual([
      "app.t.u_id: its default gen_random_uuid() is not in schema.ts, so the API requires a value for it on insert.",
    ]);
  });

  test("SET DEFAULT needs a default fk() can take", () => {
    const { skipped } = renderSchemaSource(
      [
        tableOf({
          name: "u",
          primaryKey: ["id"],
          columns: [col("id", "uuid", { notNull: true })],
        }),
        keyed(
          "t",
          [col("u_id", "uuid", { defaultExpr: "gen_random_uuid()" })],
          [fk("u_id", "u", { onDelete: "set default" })],
        ),
      ],
      "app",
    );
    expect(skipped.map((skip) => skip.reason)).toEqual([
      "foreign key to u(id) is not kept: SET DEFAULT without a default the builder can express",
    ]);
  });
});
