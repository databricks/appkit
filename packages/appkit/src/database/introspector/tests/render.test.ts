import { describe, expect, test } from "vitest";
import { renderSchema } from "../render";
import type { IntrospectionResult } from "../types";

const fixture: IntrospectionResult = {
  schemas: ["app"],
  tables: [
    {
      schema: "app",
      name: "post",
      policies: [],
      columns: [
        {
          name: "id",
          pgType: "int4",
          nullable: false,
          hasDefault: true,
          isPrimaryKey: true,
          serverGenerated: true,
        },
        {
          name: "author_id",
          pgType: "int4",
          nullable: false,
          hasDefault: false,
          references: {
            schema: "app",
            table: "user",
            column: "id",
            onDelete: "cascade",
          },
        },
        { name: "title", pgType: "text", nullable: false, hasDefault: false },
      ],
    },
    {
      schema: "app",
      name: "user",
      policies: [],
      columns: [
        {
          name: "id",
          pgType: "int4",
          nullable: false,
          hasDefault: true,
          isPrimaryKey: true,
          serverGenerated: true,
        },
        {
          name: "external_id",
          pgType: "text",
          nullable: false,
          hasDefault: false,
          isPrimaryKey: true,
        },
        { name: "email", pgType: "text", nullable: false, hasDefault: false },
        {
          name: "role",
          pgType: "text",
          nullable: false,
          hasDefault: true,
          defaultExpression: "'member'::text",
        },
      ],
    },
  ],
};

describe("renderSchema", () => {
  test("emits defineSchema source with dependencies declared first", () => {
    const out = renderSchema(fixture);

    expect(out.indexOf("const userCols = {")).toBeLessThan(
      out.indexOf("const postCols = {"),
    );
    expect(out).toContain("id: id()");
    expect(out).toContain("external_id: text().notNull().primaryKey()");
    expect(out).toContain("email: text().notNull()");
    expect(out).toContain('role: text().notNull().default("member")');
    expect(out).toContain(
      'author_id: fk(userCols.id).onDelete("cascade").notNull()',
    );
    expect(out).toContain("return { user, post };");
  });

  test("keeps table variable names valid for snake_case tables", () => {
    const out = renderSchema({
      schemas: ["app"],
      tables: [
        {
          schema: "app",
          name: "audit_log",
          policies: [],
          columns: [
            {
              name: "id",
              pgType: "int4",
              nullable: false,
              hasDefault: true,
              serverGenerated: true,
            },
          ],
        },
      ],
    });

    expect(out).toContain('const auditLog = table("audit_log", auditLogCols);');
  });

  test("preserves non-default Postgres schema names", () => {
    const out = renderSchema({
      schemas: ["public"],
      tables: [
        {
          schema: "public",
          name: "cases",
          policies: [],
          columns: [
            {
              name: "case_id",
              pgType: "text",
              nullable: false,
              hasDefault: false,
              isPrimaryKey: true,
            },
          ],
        },
      ],
    });

    expect(out).toContain('}, { schemaName: "public" });');
  });

  test("derives schemaName from actual tables when defaults include app and public", () => {
    const out = renderSchema({
      schemas: ["app", "public"],
      tables: [
        {
          schema: "public",
          name: "cases",
          policies: [],
          columns: [
            {
              name: "case_id",
              pgType: "text",
              nullable: false,
              hasDefault: false,
              isPrimaryKey: true,
            },
          ],
        },
      ],
    });

    expect(out).toContain('}, { schemaName: "public" });');
  });

  test("rejects rendering multiple schemas into one defineSchema file", () => {
    expect(() =>
      renderSchema({
        schemas: ["app", "public"],
        tables: [
          {
            schema: "app",
            name: "user",
            policies: [],
            columns: [],
          },
          {
            schema: "public",
            name: "user",
            policies: [],
            columns: [],
          },
        ],
      }),
    ).toThrow(/multiple database schemas/i);
  });

  test("emits bigid() for server-generated int8 primary keys", () => {
    const out = renderSchema({
      schemas: ["public"],
      tables: [
        {
          schema: "public",
          name: "messages",
          policies: [],
          columns: [
            {
              name: "id",
              pgType: "int8",
              nullable: false,
              hasDefault: true,
              isPrimaryKey: true,
              serverGenerated: true,
              defaultExpression: "nextval('messages_id_seq'::regclass)",
            },
            {
              name: "content",
              pgType: "text",
              nullable: false,
              hasDefault: false,
            },
          ],
        },
      ],
    });

    expect(out).toContain("id: bigid()");
    // Crucial: the import line must include bigid so the rendered file compiles
    expect(out).toContain("bigid,");
  });

  test("renders bare literal defaults (boolean, numeric, null) without TODO", () => {
    const out = renderSchema({
      schemas: ["public"],
      tables: [
        {
          schema: "public",
          name: "cases",
          policies: [],
          columns: [
            {
              name: "case_id",
              pgType: "text",
              nullable: false,
              hasDefault: false,
              isPrimaryKey: true,
            },
            {
              name: "is_historical",
              pgType: "bool",
              nullable: false,
              hasDefault: true,
              defaultExpression: "false",
            },
            {
              name: "is_locked",
              pgType: "bool",
              nullable: false,
              hasDefault: true,
              defaultExpression: "TRUE::boolean",
            },
            {
              name: "alert_count",
              pgType: "int4",
              nullable: false,
              hasDefault: true,
              defaultExpression: "0",
            },
            {
              name: "ttl_seconds",
              pgType: "int4",
              nullable: false,
              hasDefault: true,
              defaultExpression: "30::integer",
            },
            {
              name: "score",
              pgType: "int4",
              nullable: false,
              hasDefault: true,
              defaultExpression: "-1",
            },
            {
              name: "deleted_at",
              pgType: "timestamp",
              nullable: true,
              hasDefault: true,
              defaultExpression: "NULL",
            },
            {
              name: "created_at",
              pgType: "timestamp",
              nullable: false,
              hasDefault: true,
              defaultExpression: "CURRENT_TIMESTAMP",
            },
          ],
        },
      ],
    });

    expect(out).toContain("is_historical: boolean().notNull().default(false)");
    expect(out).toContain("is_locked: boolean().notNull().default(true)");
    expect(out).toContain("alert_count: integer().notNull().default(0)");
    expect(out).toContain("ttl_seconds: integer().notNull().default(30)");
    expect(out).toContain("score: integer().notNull().default(-1)");
    expect(out).toContain("deleted_at: timestamp(),");
    expect(out).toContain("created_at: timestamp().notNull().defaultNow()");
    expect(out).not.toContain("/* TODO: default");
  });

  test("keeps self-references compileable with a TODO column", () => {
    const out = renderSchema({
      schemas: ["app"],
      tables: [
        {
          schema: "app",
          name: "category",
          policies: [],
          columns: [
            {
              name: "id",
              pgType: "int4",
              nullable: false,
              hasDefault: true,
              isPrimaryKey: true,
              serverGenerated: true,
            },
            {
              name: "parent_id",
              pgType: "int4",
              nullable: true,
              hasDefault: false,
              references: {
                schema: "app",
                table: "category",
                column: "id",
              },
            },
          ],
        },
      ],
    });

    expect(out).toContain(
      "parent_id: integer() /* TODO: foreign key to category.id */",
    );
  });
});
