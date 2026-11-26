import { is } from "drizzle-orm";
import { isPgEnum, PgSchema, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, test } from "vitest";

import { defineSchema, enumColumn, fk, id, text } from "../../schema-builder";
import { drizzleKitImports } from "../drizzle-exports";

describe("drizzleKitImports", () => {
  const schema = defineSchema(({ table }) => {
    const users = table("users", {
      id: id(),
      role: enumColumn("user_role", ["admin", "member"]),
      backup: enumColumn("user_role", ["admin", "member"]),
    });
    const posts = table("posts", {
      id: id(),
      author: fk(() => users.id),
      title: text(),
    });
    return { users, posts };
  });

  test("exports every engine table and each referenced enum once", () => {
    const values = Object.values(drizzleKitImports(schema));
    expect(values.filter((value) => is(value, PgTable))).toEqual([
      schema.$engine.users,
      schema.$engine.posts,
    ]);
    const enums = values.filter((value) => isPgEnum(value));
    expect(enums).toHaveLength(1);
    const [userRole] = enums;
    expect(userRole.enumName).toBe("user_role");
    expect(userRole.schema).toBe("app");
    expect(userRole.enumValues).toEqual(["admin", "member"]);
  });

  test("never exports the pgSchema object, so drizzle-kit emits no CREATE SCHEMA", () => {
    const values = Object.values(drizzleKitImports(schema));
    expect(values.some((value) => is(value, PgSchema))).toBe(false);
  });

  test("an empty schema has nothing to export", () => {
    expect(Object.keys(drizzleKitImports(defineSchema(() => ({}))))).toEqual(
      [],
    );
  });
});
