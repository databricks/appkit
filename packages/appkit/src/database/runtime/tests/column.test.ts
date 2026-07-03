import { describe, expect, it } from "vitest";
import { defineSchema, id, text } from "../../schema-builder";
import { colOf } from "../index";

const schema = defineSchema((t) => {
  const users = t.table("users", { id: id(), name: text() });
  return { users };
});

describe("colOf", () => {
  it("returns the engine column behind a known key", () => {
    const col = colOf(schema.$tables.users, "id");
    expect(col).toBe(schema.$tables.users.$columns.id.engineColumn);
  });

  it("throws on an unknown column", () => {
    expect(() => colOf(schema.$tables.users, "nope")).toThrow(
      /Unknown column "users.nope"/,
    );
  });
});
