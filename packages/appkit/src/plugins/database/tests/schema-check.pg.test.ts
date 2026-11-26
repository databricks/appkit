import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  createDrizzleDataPath,
  createDrizzleDb,
} from "../../../database/runtime/engine/drizzle-data-path";
import { defineSchema, id, text } from "../../../database/schema-builder";
import { assertSchemaMatchesDatabase } from "../schema-check";

// See database/migrations/tests/apply.pg.test.ts for APPKIT_TEST_PG_URL.
const url = process.env.APPKIT_TEST_PG_URL;
const ROLE_PASSWORD = "appkit-test";

describe.skipIf(!url)("assertSchemaMatchesDatabase against Postgres", () => {
  let admin: Pool;
  let app: Pool | undefined;
  let schemaName: string;
  let owner: string;
  let appRole: string;

  beforeEach(async () => {
    const suffix = randomUUID().slice(0, 8);
    schemaName = `appkit_test_${suffix}`;
    owner = `appkit_owner_${suffix}`;
    appRole = `appkit_app_${suffix}`;
    admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`create role "${owner}" nologin`);
    await admin.query(
      `create role "${appRole}" login password '${ROLE_PASSWORD}'`,
    );
    await admin.query(`create schema "${schemaName}" authorization "${owner}"`);
    await admin.query(
      `create table "${schemaName}"."notes" (id serial primary key, body text)`,
    );
  });

  afterEach(async () => {
    await app?.end();
    app = undefined;
    await admin.query(`drop schema if exists "${schemaName}" cascade`);
    await admin.query(`drop role "${appRole}"`);
    await admin.query(`drop role "${owner}"`);
    await admin.end();
  });

  const check = () => {
    const target = new URL(url ?? "");
    target.username = appRole;
    target.password = ROLE_PASSWORD;
    app = new Pool({ connectionString: target.toString(), max: 1 });
    const schema = defineSchema(
      ({ table }) => ({ notes: table("notes", { id: id(), body: text() }) }),
      { schemaName },
    );
    const dataPath = createDrizzleDataPath(
      createDrizzleDb(app, schema),
      schema,
      {
        columnAccess: "trusted",
      },
    );
    return assertSchemaMatchesDatabase(dataPath, schema, { kind: "off" });
  };

  test("every table exists, but the schema belongs to another role and the app has no USAGE: setup fails with the ownership hint", async () => {
    const error = await check().catch((caught: unknown) => caught);

    expect(error).toMatchObject({ category: "SETUP_FAILED", phase: "setup" });
    expect((error as Error).message).toContain(
      `role "${appRole}" has no USAGE on schema "${schemaName}". ` +
        `Schema "${schemaName}" is owned by "${owner}", but the app connects as "${appRole}".`,
    );
  });

  test("USAGE granted on another role's schema passes", async () => {
    await admin.query(`grant usage on schema "${schemaName}" to "${appRole}"`);

    await expect(check()).resolves.toBeUndefined();
  });
});
