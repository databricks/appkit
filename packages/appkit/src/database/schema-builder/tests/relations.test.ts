import { describe, expect, it } from "vitest";
import {
  type AppKitTable,
  buildRelations,
  type ColumnMeta,
  defineSchema,
  fk,
  id,
  type ResolvedRelation,
  text,
} from "../index";

describe("buildRelations — forward toOne", () => {
  const schema = defineSchema((t) => {
    const cases = t.table("cases", { id: id() });
    const notes = t.table("notes", { id: id(), caseId: fk(() => cases.id) });
    return { cases, notes };
  });

  it("creates a forward toOne named after the target table on the FK owner", () => {
    const relations: ResolvedRelation[] = schema.$tables.notes.$relations;
    expect(relations).toEqual([
      {
        name: "cases",
        cardinality: "toOne",
        localColumn: "caseId",
        targetTable: "cases",
        targetColumn: "id",
        inferred: false,
      },
    ]);
  });
});

describe("buildRelations — inferred reverse toMany", () => {
  it("infers the reverse toMany using the SOURCE table name verbatim", () => {
    const schema = defineSchema((t) => {
      const cases = t.table("cases", { id: id() });
      const notes = t.table("notes", { id: id(), caseId: fk(() => cases.id) });
      return { cases, notes };
    });
    const reverse: ResolvedRelation[] = schema.$tables.cases.$relations;
    expect(reverse).toEqual([
      {
        // verbatim source name — NOT re-pluralized to "noteses"
        name: "notes",
        cardinality: "toMany",
        localColumn: "id",
        targetTable: "notes",
        targetColumn: "caseId",
        inferred: true,
      },
    ]);
  });

  it("leaves an already-plural source name unchanged on the reverse relation", () => {
    const schema = defineSchema((t) => {
      const cases = t.table("cases", { id: id() });
      const statusHistory = t.table("status_history", {
        id: id(),
        caseId: fk(() => cases.id),
      });
      return { cases, statusHistory };
    });
    expect(schema.$tables.cases.$relations.map((r) => r.name)).toEqual([
      "status_history",
    ]);
  });
});

describe("buildRelations — self references", () => {
  it("keeps only the forward toOne for a self-referential FK", () => {
    const schema = defineSchema((t) => {
      const nodes = t.table("nodes", {
        id: id(),
        parentId: fk(() => ({
          __isColumnRef: true,
          tableName: "nodes",
          columnName: "id",
        })),
      });
      return { nodes };
    });
    const relations: ResolvedRelation[] = schema.$tables.nodes.$relations;
    expect(relations).toEqual([
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
});

/** Minimal `AppKitTable` factory for exercising `buildRelations` directly. */
function makeTable(
  name: string,
  columns: Record<string, Partial<ColumnMeta> & { columnName: string }>,
): AppKitTable {
  return {
    $name: name,
    $schemaName: "public",
    $columns: columns as Record<string, ColumnMeta>,
    $engine: {} as AppKitTable["$engine"],
    $relations: [],
  };
}

describe("buildRelations — direct invocation", () => {
  it("populates forward toOne and reverse toMany across the table map", () => {
    const cases = makeTable("cases", { id: { columnName: "id" } });
    const notes = makeTable("notes", {
      id: { columnName: "id" },
      caseId: {
        columnName: "caseId",
        fk: { targetTable: "cases", targetColumn: "id" },
      },
    });

    buildRelations({ cases, notes });

    expect(notes.$relations).toEqual([
      {
        name: "cases",
        cardinality: "toOne",
        localColumn: "caseId",
        targetTable: "cases",
        targetColumn: "id",
        inferred: false,
      },
    ]);
    expect(cases.$relations).toEqual([
      {
        name: "notes",
        cardinality: "toMany",
        localColumn: "id",
        targetTable: "notes",
        targetColumn: "caseId",
        inferred: true,
      },
    ]);
  });
});

describe("buildRelations — collision + ambiguity guards", () => {
  it("throws when a forward relation name collides with a column", () => {
    expect(() =>
      defineSchema((t) => {
        const tag = t.table("tag", { id: id() });
        const post = t.table("post", {
          id: id(),
          tag: text(),
          tagId: fk(() => tag.id),
        });
        return { tag, post };
      }),
    ).toThrow(/Forward relation "post\.tag" collides with a column/);
  });

  it("throws when two FKs target the same table (ambiguous forward)", () => {
    expect(() =>
      defineSchema((t) => {
        const users = t.table("users", { id: id() });
        const messages = t.table("messages", {
          id: id(),
          senderId: fk(() => users.id),
          recipientId: fk(() => users.id),
        });
        return { users, messages };
      }),
    ).toThrow(/Ambiguous forward relation "messages\.users"/);
  });

  it("throws when a reverse relation name collides with a column on the target", () => {
    expect(() =>
      defineSchema((t) => {
        const notes = t.table("notes", { id: id(), posts: text() });
        const posts = t.table("posts", {
          id: id(),
          noteId: fk(() => notes.id),
        });
        return { notes, posts };
      }),
    ).toThrow(/Reverse relation "notes\.posts" collides with a column/);
  });
});
