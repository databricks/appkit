import { describe, expect, test } from "vitest";

import {
  cleanStatements,
  FOREIGN_OWNERS_SQL,
  ownershipHint,
} from "../ownership";

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
    expect(hint).toContain(
      "On your dev or session branch it is you: `appkit db init` hands you the objects",
    );
  });

  test("any other failure gets no ownership hint", () => {
    expect(ownershipHint("42P07")).toBeUndefined();
    expect(ownershipHint(undefined)).toBeUndefined();
  });
});

describe("cleanStatements", () => {
  test("a non-public app schema is dropped as a unit, journal included", () => {
    expect(cleanStatements("app")).toEqual([
      `DROP SCHEMA IF EXISTS "app" CASCADE`,
    ]);
    expect(cleanStatements('we"ird')).toEqual([
      `DROP SCHEMA IF EXISTS "we""ird" CASCADE`,
    ]);
  });

  test("public is kept; only what current_user owns in it is dropped", () => {
    const [statement, ...rest] = cleanStatements("public");
    expect(rest).toEqual([]);
    expect(statement).toMatch(/^DO \$appkit\$/);
    expect(statement).not.toContain("DROP SCHEMA");
    expect(statement).toContain("n.nspname = 'public'");
    expect(statement).toContain(
      "c.relowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)",
    );
    // Column-owned sequences go with their table; table row types are not dropped separately.
    expect(statement).toContain("d.deptype IN ('a', 'i')");
    expect(statement).toContain("DROP TYPE IF EXISTS public.%I CASCADE");
  });
});

describe("FOREIGN_OWNERS_SQL", () => {
  test("lists owners of user schemas, relations, types and functions other than current_user", () => {
    for (const catalog of ["pg_namespace", "pg_class", "pg_type", "pg_proc"]) {
      expect(FOREIGN_OWNERS_SQL).toContain(`pg_catalog.${catalog}`);
    }
    expect(FOREIGN_OWNERS_SQL).toContain(
      "n.nspname !~ '^pg_' and n.nspname <> 'information_schema'",
    );
    expect(FOREIGN_OWNERS_SQL).toContain("where r.rolname = current_user");
  });
});
