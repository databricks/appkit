import { describe, expect, test } from "vitest";
import { diffIntrospections } from "../diff";
import type { IntrospectionResult } from "../types";

const base: IntrospectionResult = {
  schemas: ["app"],
  tables: [
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
        },
      ],
    },
  ],
};

describe("diffIntrospections", () => {
  test("returns no drift when snapshots match", () => {
    expect(diffIntrospections(base, base)).toEqual({
      hasDrift: false,
      entries: [],
    });
  });

  test("reports live-only tables and schema-only columns", () => {
    const live: IntrospectionResult = {
      ...base,
      tables: [
        ...base.tables,
        { schema: "app", name: "audit_log", policies: [], columns: [] },
      ],
    };
    const declared: IntrospectionResult = {
      ...base,
      tables: [
        {
          ...base.tables[0],
          columns: [
            ...base.tables[0].columns,
            {
              name: "email",
              pgType: "text",
              nullable: false,
              hasDefault: false,
            },
          ],
        },
      ],
    };

    const report = diffIntrospections(live, declared);

    expect(report.hasDrift).toBe(true);
    expect(report.entries.map((entry) => entry.message)).toEqual(
      expect.arrayContaining([
        "+ table app.audit_log (exists in db, missing in schema.ts)",
        "- column app.user.email (in schema.ts, missing in db)",
      ]),
    );
  });

  test("reports type mismatches", () => {
    const declared: IntrospectionResult = {
      ...base,
      tables: [
        {
          ...base.tables[0],
          columns: [{ ...base.tables[0].columns[0], pgType: "text" }],
        },
      ],
    };

    expect(diffIntrospections(base, declared).entries[0]).toMatchObject({
      kind: "type-mismatch",
      message: "~ column app.user.id (text declared, int4 in db)",
    });
  });

  test("reports drift in nullability, defaults, keys, and foreign keys", () => {
    const live: IntrospectionResult = {
      schemas: ["app"],
      tables: [
        {
          schema: "app",
          name: "post",
          policies: [],
          columns: [
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
          ],
        },
      ],
    };
    const declared: IntrospectionResult = {
      schemas: ["app"],
      tables: [
        {
          schema: "app",
          name: "post",
          policies: [],
          columns: [
            {
              name: "author_id",
              pgType: "int4",
              nullable: true,
              hasDefault: true,
              defaultExpression: "0",
              isPrimaryKey: true,
            },
          ],
        },
      ],
    };

    expect(
      diffIntrospections(live, declared).entries.map((e) => e.message),
    ).toEqual(
      expect.arrayContaining([
        "~ column app.post.author_id nullable (true declared, false in db)",
        "~ column app.post.author_id hasDefault (true declared, false in db)",
        '~ column app.post.author_id defaultExpression ("0" declared, undefined in db)',
        "~ column app.post.author_id isPrimaryKey (true declared, false in db)",
        "~ column app.post.author_id foreign key (none declared, app.user.id onDelete=cascade onUpdate=no action in db)",
      ]),
    );
  });
});
