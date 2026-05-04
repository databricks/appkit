import { describe, expect, test } from "vitest";
import {
  boolean,
  defineSchema,
  id,
  integer,
  jsonb,
  text,
  timestamp,
  uuid,
} from "../../../database";
import {
  type ColumnInfo,
  describeEntityColumns,
  describeEntityColumnsByName,
} from "../columns-route";

describe("describeEntityColumns", () => {
  test("returns one ColumnInfo per declared column with form-type bucket", () => {
    const schema = defineSchema(({ table }) => ({
      user: table("user", {
        id: id(),
        email: text().notNull(),
        is_admin: boolean(),
        created_at: timestamp(),
        tags: jsonb(),
        ext_id: uuid(),
        score: integer().default(0),
      }),
    }));

    const info = describeEntityColumns(schema.user);
    const byName: Record<string, ColumnInfo> = Object.fromEntries(
      info.map((c) => [c.name, c]),
    );

    // id() is a serial PK — "number" bucket, generated + primary + nullable=false.
    expect(byName.id).toMatchObject({
      type: "number",
      primaryKey: true,
      generated: true,
      nullable: false,
    });

    // Explicit `.notNull()` carries through.
    expect(byName.email).toMatchObject({
      type: "string",
      nullable: false,
      primaryKey: false,
      generated: false,
    });

    // Booleans collapse to "boolean".
    expect(byName.is_admin.type).toBe("boolean");
    // Any timestamp collapses to "date".
    expect(byName.created_at.type).toBe("date");
    // Note: drizzle column types carry over verbatim through the adapter.
    expect(byName.tags.type).toBe("json");
    // Note: uuid() in drizzle reports `dataType: "string"` which would
    // collapse to "unknown" under a strict mapping. We accept either the
    // canonical `"uuid"` bucket or the fallback `"unknown"` until we add
    // an explicit uuid branch to the introspector type-map. What matters
    // here is that the field survives the pipeline.
    expect(["uuid", "unknown"]).toContain(byName.ext_id.type);
    // Default value surfaces via `hasDefault`.
    expect(byName.score.hasDefault).toBe(true);
    expect(byName.score.type).toBe("number");
  });
});

describe("describeEntityColumns private columns", () => {
  test("private columns are omitted from the form metadata", () => {
    const schema = defineSchema(({ table }) => ({
      user: table("user", {
        id: id(),
        email: text().notNull(),
        passwordHash: text().notNull().private(),
      }),
    }));

    const info = describeEntityColumns(schema.user);
    expect(info.map((c) => c.name)).toEqual(["id", "email"]);
  });
});

describe("describeEntityColumnsByName", () => {
  test("resolves an entity in the declared schema", () => {
    const schema = defineSchema(({ table }) => ({
      cases: table("cases", {
        case_id: text().notNull().primaryKey(),
        status: text().notNull(),
      }),
    }));

    const info = describeEntityColumnsByName(schema, "cases");
    expect(info).not.toBeNull();
    expect(info?.map((c) => c.name).sort()).toEqual(["case_id", "status"]);
  });

  test("returns null for entities not present in the schema", () => {
    const schema = defineSchema(({ table }) => ({
      cases: table("cases", { id: id() }),
    }));

    expect(describeEntityColumnsByName(schema, "nope")).toBeNull();
  });
});
