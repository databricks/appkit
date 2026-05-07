import { describe, expect, test } from "vitest";
import { defineSchema, fk, id, text } from "../../schema-builder";
import { schemaToIntrospection } from "../schema-to-introspection";

describe("schemaToIntrospection", () => {
  test("translates defined tables into IntrospectionResult", () => {
    const schema = defineSchema(({ table }) => {
      const userCols = {
        id: id(),
        email: text().notNull(),
      };
      const user = table("user", userCols);
      const post = table("post", {
        id: id(),
        authorId: fk(userCols.id).onDelete("cascade"),
        title: text().notNull(),
      });
      return { user, post };
    });

    const result = schemaToIntrospection(schema);
    const post = result.tables.find((table) => table.name === "post");

    expect(result.schemas).toEqual(["public"]);
    expect(result.tables.map((table) => table.name)).toEqual(["user", "post"]);
    expect(
      post?.columns.find((column) => column.name === "authorId"),
    ).toMatchObject({
      references: {
        table: "user",
        column: "id",
        onDelete: "cascade",
      },
    });
  });
});
