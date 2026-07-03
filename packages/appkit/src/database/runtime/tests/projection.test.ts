import { describe, expect, it } from "vitest";
import { defineSchema, id, integer, text } from "../../schema-builder";
import { defaultColumns, stripPrivate } from "../index";

const schema = defineSchema((t) => {
  const users = t.table("users", {
    id: id(),
    name: text(),
    age: integer(),
    secret: text().private(),
    token: text().private(),
  });
  const notes = t.table("notes", {
    id: id(),
    body: text(),
  });
  return { users, notes };
});

const users = schema.$tables.users;
const notes = schema.$tables.notes;

describe("defaultColumns", () => {
  it("keeps every non-private column", () => {
    expect(defaultColumns(users)).toEqual({ id: true, name: true, age: true });
  });

  it("drops private columns", () => {
    const cols = defaultColumns(users);
    expect(cols).not.toHaveProperty("secret");
    expect(cols).not.toHaveProperty("token");
  });

  it("returns every column when none are private", () => {
    expect(defaultColumns(notes)).toEqual({ id: true, body: true });
  });
});

describe("stripPrivate", () => {
  it("removes private keys from a row", () => {
    const row = { id: 1, name: "bob", age: 7, secret: "s", token: "t" };
    expect(stripPrivate(users, row)).toEqual({ id: 1, name: "bob", age: 7 });
  });

  it("returns the same row reference when nothing is private", () => {
    const row = { id: 1, body: "hi" };
    expect(stripPrivate(notes, row)).toBe(row);
  });

  it("does not mutate the input row", () => {
    const row = { id: 1, name: "bob", secret: "s" };
    stripPrivate(users, row);
    expect(row).toHaveProperty("secret", "s");
  });

  it("ignores private columns that are absent from the row", () => {
    expect(stripPrivate(users, { id: 1, secret: "s" })).toEqual({ id: 1 });
  });
});
