import { describe, expect, it } from "vitest";
import {
  defineSchema,
  fk,
  id,
  isPrivateColumn,
  nonPrivateColumnNames,
  ownerColumnName,
  privateColumnNames,
  text,
} from "../index";

const schema = defineSchema((t) => {
  const users = t.table("users", {
    id: id(),
    email: text().notNull().owner(),
    name: text(),
    passwordHash: text().private(),
  });
  const posts = t.table("posts", {
    id: id(),
    authorId: fk(() => users.id),
    title: text(),
  });
  return { users, posts };
});

const users = schema.$tables.users;

describe("isPrivateColumn", () => {
  it("reflects the .private() modifier", () => {
    expect(isPrivateColumn(users.$columns.passwordHash)).toBe(true);
    expect(isPrivateColumn(users.$columns.email)).toBe(false);
  });
});

describe("privateColumnNames / nonPrivateColumnNames", () => {
  it("partitions the columns by privacy", () => {
    expect(privateColumnNames(users)).toEqual(["passwordHash"]);
    expect(nonPrivateColumnNames(users)).toEqual(["id", "email", "name"]);
  });

  it("returns an empty private list when none are marked", () => {
    expect(privateColumnNames(schema.$tables.posts)).toEqual([]);
  });
});

describe("ownerColumnName", () => {
  it("returns the column flagged with .owner()", () => {
    expect(ownerColumnName(users)).toBe("email");
  });

  it("returns undefined when no owner column is declared", () => {
    expect(ownerColumnName(schema.$tables.posts)).toBeUndefined();
  });
});
