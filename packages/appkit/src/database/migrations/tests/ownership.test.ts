import { describe, expect, test } from "vitest";

import { ownershipHint } from "../ownership";

describe("ownership: one owner per branch", () => {
  test("insufficient_privilege gets the branch-owner rule and the fix", () => {
    const hint = ownershipHint("42501");
    expect(hint).toContain(
      "lacks a privilege this migration needs: CREATE on the database, or ownership of the app schema and its tables",
    );
    expect(hint).toContain(
      "On the deploy branch that role is the app's service principal: bind the database to the app with CAN_CONNECT_AND_CREATE",
    );
    expect(hint).toContain("use another schemaName in schema.ts");
  });

  test("any other failure gets no ownership hint", () => {
    expect(ownershipHint("42P07")).toBeUndefined();
    expect(ownershipHint(undefined)).toBeUndefined();
  });
});
