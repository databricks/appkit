import { describe, expect, test } from "vitest";
import { APPKIT_TABLE, defineSchema, fk, id, text } from "../schema-builder";

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
});
