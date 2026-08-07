import { describe, expect, it } from "vitest";

import {
  defineSchema,
  fk,
  id,
  jsonb,
  text,
  timestamp,
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
  const invites = builder.table("invites", {
    code: text().primaryKey(),
    email: text().notNull(),
    label: text().default("guest"),
    createdAt: timestamp().defaultNow(),
  });
  return { users, notes, invites };
});

const tables = compileCrudTables(schema.$tables);
const users = tables.get("users") as NonNullable<ReturnType<typeof tables.get>>;
const notes = tables.get("notes") as NonNullable<ReturnType<typeof tables.get>>;
const invites = tables.get("invites") as NonNullable<
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

  it("treats a private primary key as no key over HTTP", () => {
    const hidden = defineSchema((builder) => ({
      audits: builder.table("audits", {
        id: id().private(),
        action: text(),
      }),
    }));
    const audits = compileCrudTables(hidden.$tables).get("audits");
    // No key means no detail route and no existence oracle on the hidden id.
    expect(audits?.primaryKey).toBeUndefined();
    expect(audits?.columns.has("id")).toBe(true);
    expect([...(audits?.selectable ?? [])]).toEqual(["action"]);
  });
});

describe("write allowlists", () => {
  it("allows a caller-chosen key on create but never a generated one", () => {
    expect([...users.creatable]).toEqual(["name", "profile"]);
    expect([...users.updatable]).toEqual(["name", "profile"]);
    expect([...invites.creatable]).toEqual([
      "code",
      "email",
      "label",
      "createdAt",
    ]);
    // A key rewrite would move the row out from under every reference to it,
    // and a caller who could rewrite `createdAt` could rewrite history.
    expect([...invites.updatable]).toEqual(["email", "label"]);
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
