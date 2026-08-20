import { describe, expect, it } from "vitest";

import {
  type ColumnBuilder,
  defineSchema,
  fk,
  id,
  type ResolvedRelation,
  type TableHandle,
  text,
} from "../index";

describe("deterministic relation metadata", () => {
  it("uses target/source table identity for forward and reverse relations", () => {
    const schema = defineSchema((builder) => {
      const cases = builder.table("cases", { id: id() });
      const status_history = builder.table("status_history", {
        id: id(),
        caseId: fk(() => cases.id),
      });
      return { cases, status_history };
    });

    const forward: readonly ResolvedRelation[] =
      schema.$tables.status_history.$relations;
    const reverse: readonly ResolvedRelation[] =
      schema.$tables.cases.$relations;

    expect(forward).toEqual([
      {
        name: "cases",
        cardinality: "toOne",
        localColumn: "caseId",
        targetTable: "cases",
        targetColumn: "id",
        inferred: false,
      },
    ]);
    expect(reverse).toEqual([
      {
        name: "status_history",
        cardinality: "toMany",
        localColumn: "id",
        targetTable: "status_history",
        targetColumn: "caseId",
        inferred: true,
      },
    ]);
  });

  it("keeps reverse relations toMany even for a unique FK", () => {
    const schema = defineSchema((builder) => {
      const users = builder.table("users", { id: id() });
      const profiles = builder.table("profiles", {
        id: id(),
        userId: fk(() => users.id).unique(),
      });
      return { users, profiles };
    });
    expect(schema.$tables.users.$relations[0].cardinality).toBe("toMany");
  });

  it("exposes only the forward relation for a self reference", () => {
    const schema = defineSchema((builder) => {
      let nodes: TableHandle<{ id: ColumnBuilder; parentId: ColumnBuilder }>;
      nodes = builder.table("nodes", {
        id: id(),
        parentId: fk(() => nodes.id),
      });
      return { nodes };
    });
    expect(schema.$tables.nodes.$relations).toEqual([
      {
        name: "nodes",
        cardinality: "toOne",
        localColumn: "parentId",
        targetTable: "nodes",
        targetColumn: "id",
        inferred: false,
      },
    ]);
  });

  it("freezes relation objects and arrays", () => {
    const schema = defineSchema((builder) => {
      const users = builder.table("users", { id: id() });
      const posts = builder.table("posts", {
        id: id(),
        userId: fk(() => users.id),
      });
      return { users, posts };
    });
    expect(Object.isFrozen(schema.$tables.users.$relations)).toBe(true);
    expect(Object.isFrozen(schema.$tables.users.$relations[0])).toBe(true);
    expect(() => {
      (schema.$tables.users.$relations as unknown[]).push({});
    }).toThrow(TypeError);
  });
});

describe("relation ambiguity guards", () => {
  it("rejects multiple FKs from one table to the same target", () => {
    expect(() =>
      defineSchema((builder) => {
        const users = builder.table("users", { id: id() });
        const messages = builder.table("messages", {
          id: id(),
          senderId: fk(() => users.id),
          recipientId: fk(() => users.id),
        });
        return { users, messages };
      }),
    ).toThrow(/Ambiguous forward relation/);
  });

  it("rejects forward relation/column collisions", () => {
    expect(() =>
      defineSchema((builder) => {
        const tags = builder.table("tags", { id: id() });
        const posts = builder.table("posts", {
          id: id(),
          tags: text(),
          tagId: fk(() => tags.id),
        });
        return { tags, posts };
      }),
    ).toThrow(/Forward relation .* collides with a column/);
  });

  it("rejects reverse relation/column collisions", () => {
    expect(() =>
      defineSchema((builder) => {
        const users = builder.table("users", { id: id(), posts: text() });
        const posts = builder.table("posts", {
          id: id(),
          userId: fk(() => users.id),
        });
        return { users, posts };
      }),
    ).toThrow(/Reverse relation .* collides with a column/);
  });
});
