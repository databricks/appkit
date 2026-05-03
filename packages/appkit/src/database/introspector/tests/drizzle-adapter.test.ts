import { describe, expect, test } from "vitest";
import {
  bigid,
  bigint,
  boolean,
  defineSchema,
  fk,
  id,
  integer,
  jsonb,
  text,
  timestamp,
  varchar,
} from "../../schema-builder";
import { adaptDrizzleTable } from "../drizzle-adapter";

/**
 * The big snapshot below is the canonical regression: a Drizzle minor bump
 * that changes `getTableConfig` output, the queryChunks shape, or the column
 * type literals will fail this snapshot before merge. Keep it comprehensive.
 */

describe("adaptDrizzleTable", () => {
  // The fixture exercises every distinct branch of `stringifyDefault` and
  // `drizzleTypeToPgType` we care about:
  //   - `id()` → PgSerial with a serverGenerated default
  //   - `text().default("member")` → quoted string default (no cast)
  //   - `boolean().default(true)` → primitive default
  //   - `timestamp().defaultNow()` → Drizzle `sql`now()`` queryChunks default
  //   - `integer().default(0)` → primitive numeric default
  //   - `varchar(64).primaryKey()` → varchar with explicit PK
  //   - `bigint()` → PgBigInt53 mapping
  //   - `fk(...).onDelete(...).onUpdate(...)` → relation metadata
  test("converts the canonical schema fixture into introspection shape", () => {
    const schema = defineSchema(({ table }) => {
      const userCols = {
        id: id(),
        email: text().notNull(),
        role: text().default("member"),
        active: boolean().default(true),
        profile: jsonb(),
        externalId: varchar(64).primaryKey(),
        score: bigint(),
      };
      const user = table("user", userCols);
      const post = table("post", {
        id: id(),
        authorId: fk(userCols.id).onDelete("cascade").onUpdate("restrict"),
        title: text().notNull(),
        publishedAt: timestamp(),
        createdAt: timestamp().defaultNow(),
        reviewedAt: timestamp({ timezone: true }),
        priority: integer().default(0),
      });
      return { user, post };
    });

    expect(adaptDrizzleTable(schema.user)).toMatchInlineSnapshot(`
      {
        "columns": [
          {
            "hasDefault": true,
            "isPrimaryKey": true,
            "name": "id",
            "nullable": false,
            "pgType": "int4",
            "serverGenerated": true,
          },
          {
            "hasDefault": false,
            "name": "email",
            "nullable": false,
            "pgType": "text",
          },
          {
            "defaultExpression": "member",
            "hasDefault": true,
            "name": "role",
            "nullable": true,
            "pgType": "text",
          },
          {
            "defaultExpression": "true",
            "hasDefault": true,
            "name": "active",
            "nullable": true,
            "pgType": "bool",
          },
          {
            "hasDefault": false,
            "name": "profile",
            "nullable": true,
            "pgType": "jsonb",
          },
          {
            "hasDefault": false,
            "isPrimaryKey": true,
            "name": "externalId",
            "nullable": false,
            "pgType": "varchar",
          },
          {
            "hasDefault": false,
            "name": "score",
            "nullable": true,
            "pgType": "int8",
          },
        ],
        "schema": "app",
      }
    `);
    expect(adaptDrizzleTable(schema.post)).toMatchInlineSnapshot(`
      {
        "columns": [
          {
            "hasDefault": true,
            "isPrimaryKey": true,
            "name": "id",
            "nullable": false,
            "pgType": "int4",
            "serverGenerated": true,
          },
          {
            "hasDefault": false,
            "name": "authorId",
            "nullable": true,
            "pgType": "int4",
            "references": {
              "column": "id",
              "onDelete": "cascade",
              "onUpdate": "restrict",
              "schema": "app",
              "table": "user",
            },
          },
          {
            "hasDefault": false,
            "name": "title",
            "nullable": false,
            "pgType": "text",
          },
          {
            "hasDefault": false,
            "name": "publishedAt",
            "nullable": true,
            "pgType": "timestamp",
          },
          {
            "defaultExpression": "now()",
            "hasDefault": true,
            "name": "createdAt",
            "nullable": true,
            "pgType": "timestamp",
            "serverGenerated": true,
          },
          {
            "hasDefault": false,
            "name": "reviewedAt",
            "nullable": true,
            "pgType": "timestamptz",
          },
          {
            "defaultExpression": "0",
            "hasDefault": true,
            "name": "priority",
            "nullable": true,
            "pgType": "int4",
          },
        ],
        "schema": "app",
      }
    `);
  });

  test("treats bigid() as a server-generated int8 primary key", () => {
    // Regression for the brownfield introspect → verify roundtrip on
    // bigserial PKs: the rendered schema.ts emits `bigid()` and the
    // adapter must surface it as `pgType: int8, isPrimaryKey: true,
    // serverGenerated: true` so the diff matches the live state.
    const schema = defineSchema(({ table }) => ({
      message: table("message", {
        id: bigid(),
        content: text().notNull(),
      }),
    }));

    expect(adaptDrizzleTable(schema.message).columns[0]).toEqual({
      name: "id",
      pgType: "int8",
      nullable: false,
      hasDefault: true,
      isPrimaryKey: true,
      serverGenerated: true,
    });
  });
});
