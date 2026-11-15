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
        canCreate: false,
      }),
    ).toBe(
      'Schema "app" is owned by "old-app-sp", but the app connects as "new-app-sp". ' +
        "If two apps share this database, give each its own schemaName in schema.ts. " +
        "Otherwise the app was recreated with a new service principal, or its database resource was removed and added again, " +
        'and Lakebase handed the objects to "old-app-sp". No Postgres role can hand them back to "new-app-sp"; only Lakebase can move them. ' +
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

  test("public with CREATE already granted: another role owns the object, and no role can hand it to the app", () => {
    expect(
      ownershipHint("42501", {
        schemaName: "public",
        owner: "pg_database_owner",
        currentUser: "app-sp",
        canCreate: true,
      }),
    ).toBe(
      `Role "app-sp" can create in schema public, so an object this migration changes belongs to another role, and no Postgres role can hand it to "app-sp". ` +
        "Drop schemaName from defineSchema() to use the default schema app, which the app creates and owns.",
    );
  });

  test("any other failure gets no ownership hint", () => {
    expect(ownershipHint("42P07")).toBeUndefined();
    expect(ownershipHint(undefined)).toBeUndefined();
  });
});
