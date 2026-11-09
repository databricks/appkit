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
  });

  test("a schema owned by another role names both roles and how that happens", () => {
    const hint = ownershipHint("42501", {
      schemaName: "app",
      owner: "old-app-sp",
      currentUser: "new-app-sp",
      canCreate: false,
    });
    expect(hint).toContain(
      `Schema "app" is owned by "old-app-sp", but the app connects as "new-app-sp".`,
    );
    expect(hint).toContain(
      "the app's database resource was removed and added again, or the app was recreated",
    );
    expect(hint).toContain("set another schemaName in schema.ts");
    expect(hint).toContain(
      "On your dev or session branch, rerun `appkit db init`, which hands you the schema.",
    );
  });

  test("a schema that does not exist yet points at CREATE on the database", () => {
    expect(
      ownershipHint("42501", {
        schemaName: "app",
        owner: null,
        currentUser: "app-sp",
        canCreate: null,
      }),
    ).toBe(
      `Role "app-sp" cannot create schema "app". On the deploy branch that role is the app's service principal: bind the database to the app with CAN_CONNECT_AND_CREATE.`,
    );
  });

  test("public without CREATE for the app gets the grant or the default schema", () => {
    expect(
      ownershipHint("42501", {
        schemaName: "public",
        owner: "pg_database_owner",
        currentUser: "app-sp",
        canCreate: false,
      }),
    ).toBe(
      `Schema public belongs to "pg_database_owner", and the app's role "app-sp" has no CREATE on it. ` +
        `Grant it once with GRANT CREATE ON SCHEMA public TO "app-sp", or drop schemaName from defineSchema() to use the default schema app, which the app creates and owns.`,
    );
  });

  test("public with CREATE already granted: the failure is an object another role owns, not CREATE", () => {
    const hint = ownershipHint("42501", {
      schemaName: "public",
      owner: "pg_database_owner",
      currentUser: "app-sp",
      canCreate: true,
    });

    expect(hint).not.toContain("has no CREATE");
    expect(hint).not.toContain("GRANT CREATE");
    expect(hint).toContain("belongs to another role");
    expect(hint).toContain(`OWNER TO "app-sp"`);
  });

  test("any other failure gets no ownership hint", () => {
    expect(ownershipHint("42P07")).toBeUndefined();
    expect(ownershipHint(undefined)).toBeUndefined();
  });
});
