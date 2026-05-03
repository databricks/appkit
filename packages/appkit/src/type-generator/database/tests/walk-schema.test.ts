import { describe, expect, test } from "vitest";
import {
  boolean,
  defineSchema,
  fk,
  id,
  integer,
  text,
  timestamp,
} from "../../../database/schema-builder";
import { walkSchema } from "../walk-schema";

describe("walkSchema — shape", () => {
  test("returns one entry per table with row/insert/update/filters/includes", () => {
    const schema = defineSchema(({ table }) => ({
      user: table("user", {
        id: id(),
        email: text().notNull(),
        active: boolean().default(true),
      }),
    }));

    const entries = walkSchema(schema);

    expect(entries).toHaveLength(1);
    const user = entries[0];
    expect(user?.entity).toBe("user");
    expect(user?.row).toContain("id: number;");
    expect(user?.row).toContain("email: string;");
    expect(user?.row).toContain("active: boolean | null;");
    expect(user?.includes).toBe("{}");
  });

  test("emits empty array for non-schema input", () => {
    expect(walkSchema(undefined)).toEqual([]);
    expect(walkSchema(null)).toEqual([]);
    expect(walkSchema({})).toEqual([]);
    expect(walkSchema({ $tables: "nope" })).toEqual([]);
  });
});

describe("walkSchema — row / insert / update", () => {
  test("row marks nullable columns with `| null`", () => {
    const schema = defineSchema(({ table }) => ({
      user: table("user", {
        id: id(),
        email: text().notNull(),
        bio: text(),
      }),
    }));

    const user = walkSchema(schema)[0];
    expect(user?.row).toContain("bio: string | null;");
    expect(user?.row).toContain("email: string;"); // not nullable
  });

  test("insert marks defaulted + server-generated + nullable columns optional", () => {
    const schema = defineSchema(({ table }) => ({
      user: table("user", {
        id: id(),
        email: text().notNull(),
        bio: text(),
        createdAt: timestamp().defaultNow(),
      }),
    }));

    const user = walkSchema(schema)[0];
    // Required (not nullable, no default, not server-generated):
    expect(user?.insert).toContain("email: string;");
    // Server-generated:
    expect(user?.insert).toContain("id?: number;");
    // Has default:
    expect(user?.insert).toContain("createdAt?: string | null;");
    // Nullable:
    expect(user?.insert).toContain("bio?: string | null;");
  });

  test("update marks every column optional", () => {
    const schema = defineSchema(({ table }) => ({
      user: table("user", {
        id: id(),
        email: text().notNull(),
      }),
    }));

    const user = walkSchema(schema)[0];
    expect(user?.update).toContain("id?: number;");
    expect(user?.update).toContain("email?: string;");
  });
});

describe("walkSchema — filters", () => {
  test("classifies common pg types into filter kinds", () => {
    const schema = defineSchema(({ table }) => ({
      event: table("event", {
        id: id(),
        name: text().notNull(),
        count: integer(),
        isFinal: boolean(),
        occurredAt: timestamp(),
      }),
    }));

    const event = walkSchema(schema)[0];
    expect(event?.filters).toContain('id: "number"');
    expect(event?.filters).toContain('name: "string"');
    expect(event?.filters).toContain('count: "number"');
    expect(event?.filters).toContain('isFinal: "boolean"');
    expect(event?.filters).toContain('occurredAt: "date"');
  });
});

describe("walkSchema — includes: forward + reverse", () => {
  test("single FK: forward on child + reverse on parent", () => {
    const schema = defineSchema(({ table }) => {
      const userCols = {
        id: id(),
        email: text().notNull(),
      };
      const user = table("user", userCols);
      const post = table("post", {
        id: id(),
        title: text().notNull(),
        authorId: fk(userCols.id),
      });
      return { user, post };
    });

    const entries = walkSchema(schema);
    const user = entries.find((e) => e.entity === "user");
    const post = entries.find((e) => e.entity === "post");

    // Forward (many-to-one): post → user, keyed by target entity.
    expect(post?.includes).toContain(
      'user: { row: DatabaseRegistry["user"]["row"] };',
    );
    // Reverse (one-to-many): user ← post, keyed by source entity, array-shaped.
    expect(user?.includes).toContain(
      'post: Array<{ row: DatabaseRegistry["post"]["row"] }>;',
    );
  });

  test("two FKs from the same source disambiguate by column name on both sides", () => {
    const schema = defineSchema(({ table }) => {
      const userCols = {
        id: id(),
        email: text().notNull(),
      };
      const user = table("user", userCols);
      const post = table("post", {
        id: id(),
        title: text().notNull(),
        authorId: fk(userCols.id),
        editorId: fk(userCols.id),
      });
      return { user, post };
    });

    const entries = walkSchema(schema);
    const user = entries.find((e) => e.entity === "user");
    const post = entries.find((e) => e.entity === "post");

    // Forward collision: post.includes exposes both FKs by column name.
    expect(post?.includes).toContain(
      'authorId: { row: DatabaseRegistry["user"]["row"] };',
    );
    expect(post?.includes).toContain(
      'editorId: { row: DatabaseRegistry["user"]["row"] };',
    );
    expect(post?.includes).not.toContain("user: { row:");

    // Reverse collision: user.includes also splits by column.
    expect(user?.includes).toContain(
      'authorId: Array<{ row: DatabaseRegistry["post"]["row"] }>;',
    );
    expect(user?.includes).toContain(
      'editorId: Array<{ row: DatabaseRegistry["post"]["row"] }>;',
    );
    expect(user?.includes).not.toContain("post: Array<");
  });

  test("distinct source tables do not collide", () => {
    const schema = defineSchema(({ table }) => {
      const userCols = {
        id: id(),
      };
      const user = table("user", userCols);
      const post = table("post", {
        id: id(),
        authorId: fk(userCols.id),
      });
      const comment = table("comment", {
        id: id(),
        authorId: fk(userCols.id),
      });
      return { user, post, comment };
    });

    const entries = walkSchema(schema);
    const user = entries.find((e) => e.entity === "user");

    expect(user?.includes).toContain(
      'post: Array<{ row: DatabaseRegistry["post"]["row"] }>;',
    );
    expect(user?.includes).toContain(
      'comment: Array<{ row: DatabaseRegistry["comment"]["row"] }>;',
    );
  });
});
