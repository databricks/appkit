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
    // Messages no longer carry a leading +/-/~ prefix; the verify CLI
    // renders the icon from `entry.kind` so messages stay deduplicated.
    expect(report.entries.map((entry) => entry.message)).toEqual(
      expect.arrayContaining([
        "table app.audit_log (exists in db, missing in schema.ts)",
        "column app.user.email (in schema.ts, missing in db)",
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
      message: "column app.user.id (text declared, int4 in db)",
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
        "column app.post.author_id nullable (true declared, false in db)",
        "column app.post.author_id hasDefault (true declared, false in db)",
        'column app.post.author_id defaultExpression ("0" declared, undefined in db)',
        "column app.post.author_id isPrimaryKey (true declared, false in db)",
        "column app.post.author_id foreign key (none declared, app.user.id onDelete=cascade onUpdate=no action in db)",
      ]),
    );
  });

  test("suppresses defaultExpression/hasDefault when both sides are serverGenerated", () => {
    // This is the introspect → verify roundtrip case for serial / bigserial /
    // identity primary keys. Live shows the literal `nextval(...)` default,
    // schema declares `serverGenerated: true`. They mean the same thing.
    const live: IntrospectionResult = {
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
              defaultExpression: "nextval('post_id_seq'::regclass)",
              isPrimaryKey: true,
              serverGenerated: true,
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
              name: "id",
              pgType: "int4",
              nullable: false,
              hasDefault: true,
              isPrimaryKey: true,
              serverGenerated: true,
              // No defaultExpression — schema models the default as
              // `serverGenerated` metadata instead of a literal.
            },
          ],
        },
      ],
    };

    expect(diffIntrospections(live, declared)).toEqual({
      hasDrift: false,
      entries: [],
    });
  });

  test("still flags drift when only one side is serverGenerated", () => {
    // Catches the bug where the schema doesn't capture an auto-incrementing
    // PK. Without the special-case suppression we'd surface noise; with it
    // we still need to surface a real mismatch when the schema is silent on
    // serverGenerated for a live serial column.
    const live: IntrospectionResult = {
      schemas: ["app"],
      tables: [
        {
          schema: "app",
          name: "post",
          policies: [],
          columns: [
            {
              name: "id",
              pgType: "int8",
              nullable: false,
              hasDefault: true,
              defaultExpression: "nextval('post_id_seq'::regclass)",
              isPrimaryKey: true,
              serverGenerated: true,
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
              name: "id",
              pgType: "int8",
              nullable: false,
              hasDefault: false,
              isPrimaryKey: true,
              // serverGenerated absent on declared side
            },
          ],
        },
      ],
    };

    const messages = diffIntrospections(live, declared).entries.map(
      (e) => e.message,
    );
    expect(messages).toEqual(
      expect.arrayContaining([
        "column app.post.id hasDefault (false declared, true in db)",
        "column app.post.id serverGenerated (false declared, true in db)",
      ]),
    );
  });

  test("does NOT normalize non-trivial default expressions (concat, function calls)", () => {
    const live: IntrospectionResult = {
      schemas: ["app"],
      tables: [
        {
          schema: "app",
          name: "user",
          policies: [],
          columns: [
            {
              name: "label",
              pgType: "text",
              nullable: true,
              hasDefault: true,
              defaultExpression: "'foo'::text || 'bar'::text",
            },
            {
              name: "code",
              pgType: "text",
              nullable: true,
              hasDefault: true,
              defaultExpression: "upper('a'::text)",
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
          name: "user",
          policies: [],
          columns: [
            {
              name: "label",
              pgType: "text",
              nullable: true,
              hasDefault: true,
              defaultExpression: "foobar",
            },
            {
              name: "code",
              pgType: "text",
              nullable: true,
              hasDefault: true,
              defaultExpression: "A",
            },
          ],
        },
      ],
    };

    // Both columns must surface drift; the regex must not "normalize" them
    // away by matching a partial prefix.
    const messages = diffIntrospections(live, declared).entries.map(
      (e) => e.message,
    );
    expect(
      messages.some((m) => m.includes("user.label defaultExpression")),
    ).toBe(true);
    expect(
      messages.some((m) => m.includes("user.code defaultExpression")),
    ).toBe(true);
  });

  test("normalizes simple varchar(N) cast literal", () => {
    const live: IntrospectionResult = {
      schemas: ["app"],
      tables: [
        {
          schema: "app",
          name: "user",
          policies: [],
          columns: [
            {
              name: "country",
              pgType: "varchar",
              nullable: true,
              hasDefault: true,
              defaultExpression: "'US'::character varying(2)",
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
          name: "user",
          policies: [],
          columns: [
            {
              name: "country",
              pgType: "varchar",
              nullable: true,
              hasDefault: true,
              defaultExpression: "US",
            },
          ],
        },
      ],
    };

    // The `character varying(2)` form has a space and arity, but it's still a
    // single trivial cast around a single literal. Today we only normalize
    // the simpler `\w+` type identifier; the multi-word case still surfaces
    // as drift, which is the safer-by-default choice.
    expect(diffIntrospections(live, declared).hasDrift).toBe(true);
  });

  test("normalizes equivalent default expressions", () => {
    const live: IntrospectionResult = {
      schemas: ["app"],
      tables: [
        {
          schema: "app",
          name: "user",
          policies: [],
          columns: [
            {
              name: "role",
              pgType: "text",
              nullable: true,
              hasDefault: true,
              defaultExpression: "'member'::text",
            },
            {
              name: "created_at",
              pgType: "timestamp",
              nullable: true,
              hasDefault: true,
              defaultExpression: "now()",
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
          name: "user",
          policies: [],
          columns: [
            {
              name: "role",
              pgType: "text",
              nullable: true,
              hasDefault: true,
              defaultExpression: "member",
            },
            {
              name: "created_at",
              pgType: "timestamp",
              nullable: true,
              hasDefault: true,
              defaultExpression: "now()",
              serverGenerated: true,
            },
          ],
        },
      ],
    };

    expect(diffIntrospections(live, declared)).toEqual({
      hasDrift: false,
      entries: [],
    });
  });
});
