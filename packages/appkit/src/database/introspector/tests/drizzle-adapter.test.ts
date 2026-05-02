import { describe, expect, test } from "vitest";
import {
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

describe("adaptDrizzleTable", () => {
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
});
