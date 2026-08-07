import { describe, expect, it } from "vitest";

import { DatabasePluginError } from "../../../../database/errors";
import {
  bigid,
  defineSchema,
  fk,
  id,
  jsonb,
  text,
} from "../../../../database/schema-builder";
import { MAX_SERIALIZED_DEPTH } from "../../defaults";
import { compileCrudTables } from "../contract";

const schema = defineSchema((builder) => {
  const users = builder.table("users", {
    id: id(),
    name: text(),
    token: text().private(),
    profile: jsonb(),
  });
  const notes = builder.table("notes", {
    id: id(),
    authorId: fk(() => users.id),
    body: text(),
    draft: text().private(),
  });
  const ledger = builder.table("ledger", { id: bigid(), memo: text() });
  return { users, notes, ledger };
});

const tables = compileCrudTables(schema.$tables);
const users = tables.get("users") as NonNullable<ReturnType<typeof tables.get>>;
const notes = tables.get("notes") as NonNullable<ReturnType<typeof tables.get>>;
const ledger = tables.get("ledger") as NonNullable<
  ReturnType<typeof tables.get>
>;

describe("compileCrudTables", () => {
  it("allowlists public columns and excludes unfilterable kinds", () => {
    expect([...users.selectable]).toEqual(["id", "name", "profile"]);
    expect([...users.queryable]).toEqual(["id", "name"]);
    expect(users.columns.has("token")).toBe(true);
    expect(users.primaryKey?.meta.columnName).toBe("id");
  });

  it("wires relations only between exposed tables", () => {
    expect(users.relations.get("notes")).toMatchObject({
      cardinality: "toMany",
      target: notes,
    });
    expect(notes.relations.get("users")).toMatchObject({
      cardinality: "toOne",
      target: users,
    });
    const isolated = compileCrudTables({ notes: schema.$tables.notes });
    expect(isolated.get("notes")?.relations.size).toBe(0);
  });

  it("decodes identifiers against the declared key type", () => {
    expect(users.decodeId("42")).toBe(42);
    expect(ledger.decodeId("9007199254740993")).toBe(9007199254740993n);
    expect(() => users.decodeId("abc")).toThrow(DatabasePluginError);
    expect(() => users.decodeId("abc")).toThrow(
      expect.objectContaining({
        category: "INVALID_REQUEST",
        details: [{ path: ["id"], message: expect.any(String) }],
      }),
    );
  });
});

describe("projectPublicRow", () => {
  it("drops private columns at every level and encodes relations", () => {
    const projected = users.projectPublicRow({
      id: 1,
      name: "Ada",
      token: "secret",
      profile: { theme: "dark" },
      notes: [{ id: 2, body: "hello", draft: "hidden" }],
      unknown: "ignored",
    });
    expect(projected).toEqual({
      id: 1,
      name: "Ada",
      profile: { theme: "dark" },
      notes: [{ id: 2, body: "hello" }],
    });
  });

  it("represents an absent to-one relation as null", () => {
    expect(notes.projectPublicRow({ id: 1, users: null })).toEqual({
      id: 1,
      users: null,
    });
  });
});

describe("sanitizeSerializedRow", () => {
  it("re-applies the private-column policy to serializer output", () => {
    const sanitized = users.sanitizeSerializedRow({
      id: 1,
      token: "leaked",
      computed: { label: "Ada", tags: ["a", "b"] },
      skipped: undefined,
      notes: [{ id: 2, draft: "leaked", body: "hello" }],
    });
    expect(sanitized).toEqual({
      id: 1,
      computed: { label: "Ada", tags: ["a", "b"] },
      notes: [{ id: 2, body: "hello" }],
    });
  });

  it("treats a broken serializer as an internal fault", () => {
    const cyclic: Record<string, unknown> = { id: 1 };
    cyclic.self = cyclic;
    let deep: Record<string, unknown> = {};
    for (let level = 0; level <= MAX_SERIALIZED_DEPTH; level += 1) {
      deep = { deep };
    }
    for (const broken of [
      cyclic,
      deep,
      "not-an-object",
      { id: Number.POSITIVE_INFINITY },
      { at: new Date() },
    ]) {
      expect(() => users.sanitizeSerializedRow(broken)).toThrow(
        expect.objectContaining({ category: "INTERNAL" }),
      );
    }
  });

  it("carries a __proto__ key as data rather than dropping it", () => {
    const sanitized = users.sanitizeSerializedRow({
      id: 1,
      computed: JSON.parse('{"__proto__":{"owned":true},"keep":1}'),
    }) as { computed: unknown };

    expect(JSON.stringify(sanitized.computed)).toBe(
      '{"__proto__":{"owned":true},"keep":1}',
    );
    expect(({} as Record<string, unknown>).owned).toBeUndefined();
  });
});
