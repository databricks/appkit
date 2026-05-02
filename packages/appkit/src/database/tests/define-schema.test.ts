import { describe, expect, test } from "vitest";
import {
  APPKIT_TABLE,
  boolean,
  defineSchema,
  enumeration,
  fk,
  id,
  integer,
  jsonb,
  text,
  timestamp,
  uuid,
} from "../schema-builder";

describe("defineSchema", () => {
  test("collects tables and relations", () => {
    const schema = defineSchema(({ table }) => {
      const userCols = {
        id: id(),
        email: text().notNull().unique(),
      };
      const user = table("user", userCols);
      const post = table("post", {
        id: id(),
        authorId: fk(userCols.id).onDelete("cascade"),
        title: text().notNull(),
      });

      return { user, post };
    });

    expect(schema.user[APPKIT_TABLE]).toBe(true);
    expect(Object.keys(schema.$tables)).toEqual(["user", "post"]);
    expect(schema.post.$relations).toEqual([
      {
        fromColumn: "authorId",
        toTable: "user",
        toColumn: "id",
        onDelete: "cascade",
      },
    ]);
  });

  test("derives insert and update validators", () => {
    const schema = defineSchema(({ table }) => ({
      user: table("user", {
        id: id(),
        email: text().notNull(),
      }),
    }));

    expect(
      schema.user.$insertSchema.safeParse({ email: "a@example.com" }).success,
    ).toBe(true);
    expect(schema.user.$insertSchema.safeParse({}).success).toBe(false);
    expect(
      schema.user.$updateSchema.safeParse({ email: "b@example.com" }).success,
    ).toBe(true);
  });

  describe("drizzle-zod regression coverage", () => {
    test("integer columns reject non-numbers and accept whole numbers", () => {
      const schema = defineSchema(({ table }) => ({
        product: table("product", { id: id(), price: integer().notNull() }),
      }));

      expect(
        schema.product.$insertSchema.safeParse({ price: 100 }).success,
      ).toBe(true);
      expect(
        schema.product.$insertSchema.safeParse({ price: "100" }).success,
      ).toBe(false);
      expect(
        schema.product.$insertSchema.safeParse({ price: 1.5 }).success,
      ).toBe(false);
    });

    test("boolean columns reject coerced strings", () => {
      const schema = defineSchema(({ table }) => ({
        flag: table("flag", { id: id(), on: boolean().notNull() }),
      }));

      expect(schema.flag.$insertSchema.safeParse({ on: true }).success).toBe(
        true,
      );
      expect(schema.flag.$insertSchema.safeParse({ on: "true" }).success).toBe(
        false,
      );
    });

    test("jsonb accepts arbitrary JSON shapes", () => {
      const schema = defineSchema(({ table }) => ({
        event: table("event", { id: id(), payload: jsonb().notNull() }),
      }));

      expect(
        schema.event.$insertSchema.safeParse({ payload: { a: 1 } }).success,
      ).toBe(true);
      expect(
        schema.event.$insertSchema.safeParse({ payload: [1, 2, 3] }).success,
      ).toBe(true);
      expect(
        schema.event.$insertSchema.safeParse({ payload: "hello" }).success,
      ).toBe(true);
    });

    test("nullable column accepts null; required column does not", () => {
      const schema = defineSchema(({ table }) => ({
        user: table("user", {
          id: id(),
          email: text().notNull(),
          nickname: text(),
        }),
      }));

      expect(
        schema.user.$insertSchema.safeParse({
          email: "a@x",
          nickname: null,
        }).success,
      ).toBe(true);
      expect(
        schema.user.$insertSchema.safeParse({ email: null, nickname: "Al" })
          .success,
      ).toBe(false);
    });

    test("update schema treats every field as optional, including required ones", () => {
      const schema = defineSchema(({ table }) => ({
        user: table("user", {
          id: id(),
          email: text().notNull(),
          nickname: text(),
        }),
      }));

      // Insert: email is required.
      expect(schema.user.$insertSchema.safeParse({}).success).toBe(false);
      // Update: empty patch is allowed.
      expect(schema.user.$updateSchema.safeParse({}).success).toBe(true);
      // Update: partial patch with only nickname is allowed.
      expect(
        schema.user.$updateSchema.safeParse({ nickname: "Al" }).success,
      ).toBe(true);
    });

    test("enum columns accept declared values and reject anything else", () => {
      const schema = defineSchema(({ table }) => ({
        case: table("case", {
          id: id(),
          status: enumeration("case_status", [
            "new",
            "open",
            "closed",
          ]).notNull(),
        }),
      }));

      expect(
        schema.case.$insertSchema.safeParse({ status: "new" }).success,
      ).toBe(true);
      expect(
        schema.case.$insertSchema.safeParse({ status: "archived" }).success,
      ).toBe(false);
    });

    test("timestamp accepts Date instances", () => {
      const schema = defineSchema(({ table }) => ({
        case: table("case", {
          id: id(),
          createdAt: timestamp().notNull(),
        }),
      }));

      expect(
        schema.case.$insertSchema.safeParse({ createdAt: new Date() }).success,
      ).toBe(true);
    });
  });

  test("fk() inherits target pgType for text primary keys", () => {
    const schema = defineSchema(({ table }) => {
      const caseCols = {
        case_id: text().primaryKey(),
        status: text().notNull(),
      };
      const cases = table("cases", caseCols);
      const activity_log = table("activity_log", {
        log_id: text().primaryKey(),
        case_id: fk(caseCols.case_id).notNull(),
        action: text().notNull(),
      });

      return { cases, activity_log };
    });

    expect(schema.activity_log.$columns.case_id.pgKind).toBe("text");
    expect(schema.activity_log.$relations).toEqual([
      { fromColumn: "case_id", toTable: "cases", toColumn: "case_id" },
    ]);
  });

  test("fk() inherits target pgType for uuid primary keys", () => {
    const schema = defineSchema(({ table }) => {
      const orgCols = { id: uuid().primaryKey() };
      const orgs = table("orgs", orgCols);
      const members = table("members", {
        id: uuid().primaryKey(),
        org_id: fk(orgCols.id).notNull(),
      });

      return { orgs, members };
    });

    expect(schema.members.$columns.org_id.pgKind).toBe("uuid");
    expect(schema.members.$relations).toEqual([
      { fromColumn: "org_id", toTable: "orgs", toColumn: "id" },
    ]);
  });

  test("private columns are omitted from insert and update schemas", () => {
    const schema = defineSchema(({ table }) => ({
      user: table("user", {
        id: id(),
        email: text().notNull(),
        passwordHash: text().notNull().private(),
      }),
    }));

    expect(schema.user.$columns.passwordHash.private).toBe(true);

    const inserted = schema.user.$insertSchema.safeParse({
      email: "a@example.com",
      passwordHash: "ignored",
    });
    expect(inserted.success).toBe(true);
    if (inserted.success) {
      expect("passwordHash" in (inserted.data as Record<string, unknown>)).toBe(
        false,
      );
    }

    const updated = schema.user.$updateSchema.safeParse({
      passwordHash: "ignored",
    });
    if (updated.success) {
      expect("passwordHash" in (updated.data as Record<string, unknown>)).toBe(
        false,
      );
    }
  });

  test("supports declaring tables in the public schema", () => {
    const schema = defineSchema(
      ({ table }) => ({
        user: table("user", {
          id: id(),
          email: text().notNull(),
        }),
      }),
      { schemaName: "public" },
    );

    expect(schema.user[APPKIT_TABLE]).toBe(true);
  });
});
