import { describe, expect, test } from "vitest";

import { ownershipHint } from "../ownership";

describe("ownership: one owner per branch", () => {
  test("insufficient_privilege gets the branch-owner rule and the fix, and never suggests ALTER OWNER", () => {
    expect(ownershipHint("42501")).toBe(
      "The connecting role lacks a privilege this migration needs: CREATE on the database, or ownership of the app schema and its tables. " +
        "On the deploy branch that role is the app's service principal: bind the database to the app with CAN_CONNECT_AND_CREATE. " +
        "If another role owns an object the migration changes, no Postgres role can hand it to the service principal; only Lakebase can move it.",
    );
  });

  test("a schema owned by another role names both roles, the shared-database case first, and who can move the objects", () => {
    // Measured on Lakebase: ALTER ... OWNER TO the service principal's role
    // fails with "must be able to SET ROLE", and nobody holds ADMIN or SET on it.
    expect(
      ownershipHint("42501", {
        schemaName: "app",
        owner: "old-app-sp",
        currentUser: "new-app-sp",
      }),
    ).toBe(
      'Schema "app" is owned by "old-app-sp", but the app connects as "new-app-sp". ' +
        "If two apps share this database, give each its own schemaName in schema.ts. " +
        "Otherwise the app was recreated with a new service principal, or its database resource was removed and added again, " +
        'and Lakebase handed the objects to "old-app-sp". No Postgres role can hand them back to "new-app-sp"; only Lakebase can move them.',
    );
  });

  test("a schema that does not exist yet points at CREATE on the database", () => {
    expect(
      ownershipHint("42501", {
        schemaName: "app",
        owner: null,
        currentUser: "app-sp",
      }),
    ).toBe(
      `Role "app-sp" cannot create schema "app". On the deploy branch that role is the app's service principal: bind the database to the app with CAN_CONNECT_AND_CREATE.`,
    );
  });

  test("any other failure gets no ownership hint", () => {
    expect(ownershipHint("42P07")).toBeUndefined();
    expect(ownershipHint(undefined)).toBeUndefined();
  });
});
