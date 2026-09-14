import { describe, expect, it } from "vitest";

import { DatabasePluginError } from "../../../../database/errors";
import {
  bigid,
  defineSchema,
  fk,
  id,
  jsonb,
  text,
  timestamp,
} from "../../../../database/schema-builder";
import { MAX_SERIALIZED_DEPTH } from "../../defaults";
import { compileCrudTables } from "../contract";
import { decodeCreateBody, decodeId, decodeUpdateBody } from "../request";

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
  });
  const ledger = builder.table("ledger", { id: bigid(), memo: text() });
  const invites = builder.table("invites", {
    code: text().primaryKey(),
    email: text().notNull(),
    label: text().default("guest"),
    createdAt: timestamp().defaultNow(),
  });
  return { users, notes, ledger, invites };
});

const tables = compileCrudTables(schema.$tables);
const users = tables.get("users") as NonNullable<ReturnType<typeof tables.get>>;
const notes = tables.get("notes") as NonNullable<ReturnType<typeof tables.get>>;
const ledger = tables.get("ledger") as NonNullable<
  ReturnType<typeof tables.get>
>;
const invites = tables.get("invites") as NonNullable<
  ReturnType<typeof tables.get>
>;

describe("decodeId", () => {
  it("decodes identifiers against the declared key type", () => {
    expect(decodeId(users, "42")).toBe(42);
    expect(decodeId(ledger, "9007199254740993")).toBe(9007199254740993n);
    expect(() => decodeId(users, "abc")).toThrow(DatabasePluginError);
    expect(() => decodeId(users, "abc")).toThrow(
      expect.objectContaining({
        category: "INVALID_REQUEST",
        details: [{ path: ["id"], message: expect.any(String) }],
      }),
    );
  });
});

describe("decodeCreateBody / decodeUpdateBody", () => {
  it("accepts the public columns each operation may set", () => {
    expect(
      decodeCreateBody(users, { name: "Ada", profile: { theme: "dark" } }),
    ).toEqual({ name: "Ada", profile: { theme: "dark" } });
    expect(decodeCreateBody(invites, { code: "abc", email: "a@b.c" })).toEqual({
      code: "abc",
      email: "a@b.c",
    });
    // Columns with defaults stay optional rather than becoming required.
    expect(decodeUpdateBody(invites, { label: "member" })).toEqual({
      label: "member",
    });
    expect(decodeUpdateBody(users, {})).toEqual({});
  });

  it.each<[string, () => void, string[]]>([
    ["a generated identity", () => decodeCreateBody(users, { id: 1 }), ["id"]],
    [
      "a private column",
      () => decodeCreateBody(users, { token: "t" }),
      ["body"],
    ],
    ["an unknown field", () => decodeCreateBody(users, { nope: 1 }), ["body"]],
    ["a relation name", () => decodeCreateBody(notes, { users: {} }), ["body"]],
    [
      "a key that is markup",
      () => decodeCreateBody(users, { "<img src=x onerror=alert(1)>": 1 }),
      ["body"],
    ],
    [
      "a primary key update",
      () => decodeUpdateBody(invites, { code: "b" }),
      ["code"],
    ],
    [
      "a materialized stamp update",
      () => decodeUpdateBody(invites, { createdAt: "2099-01-01T00:00:00Z" }),
      ["createdAt"],
    ],
    ["a mistyped value", () => decodeCreateBody(users, { name: 7 }), ["name"]],
    [
      "a null in a NOT NULL column",
      () => decodeCreateBody(invites, { email: null }),
      ["email"],
    ],
    [
      "a non-object body",
      () => decodeCreateBody(users, [{ name: "Ada" }]),
      ["body"],
    ],
  ])("rejects %s, naming only a public column", (_case, decode, path) => {
    const error = (() => {
      try {
        decode();
      } catch (caught) {
        return caught as DatabasePluginError;
      }
      throw new Error("expected a rejection");
    })();
    expect(error).toMatchObject({
      category: "INVALID_REQUEST",
      details: [{ path, message: expect.any(String) }],
    });
    expect(JSON.stringify(error.details)).not.toContain("Ada");
  });

  it("keeps a nullable column nullable and bounds JSON input", () => {
    expect(decodeCreateBody(users, { profile: null })).toEqual({
      profile: null,
    });
    let deep: Record<string, unknown> = {};
    for (let level = 0; level <= MAX_SERIALIZED_DEPTH; level += 1) {
      deep = { deep };
    }
    expect(() => decodeCreateBody(users, { profile: deep })).toThrow(
      expect.objectContaining({ category: "INVALID_REQUEST" }),
    );
  });
});
