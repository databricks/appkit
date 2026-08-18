import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  APPKIT_TABLE,
  type AppKitTable,
  bigid,
  boolean,
  type ColumnBuilder,
  type DefineSchemaOptions,
  defineSchema,
  fk,
  id,
  integer,
  type ResolvedRelation,
  type Schema,
  type SchemaBuilderContext,
  type TableHandle,
  text,
  timestamp,
} from "../index";
import type { EngineTable } from "../types";

/** Cast the opaque engine handle back to a real PgTable (test-only). */
const pgOf = (t: EngineTable): PgTable => t as unknown as PgTable;

describe("defineSchema — basic build", () => {
  const schema: Schema = defineSchema((t) => ({
    users: t.table("users", {
      id: id(),
      email: text().notNull().unique(),
      name: text(),
    }),
  }));

  it("returns the table keyed by its return key", () => {
    expect(Object.keys(schema.$tables)).toEqual(["users"]);
    expect(schema.$tables.users.$name).toBe("users");
  });

  it("defaults schemaName to 'public'", () => {
    expect(schema.$schemaName).toBe("public");
    expect(schema.$tables.users.$schemaName).toBe("public");
  });

  it("marks built tables with the APPKIT_TABLE symbol", () => {
    expect(
      (schema.$tables.users as unknown as Record<symbol, unknown>)[
        APPKIT_TABLE
      ],
    ).toBe(true);
  });

  it("stamps column metadata", () => {
    const cols = schema.$tables.users.$columns;
    expect(cols.id.serverGenerated).toBe(true);
    expect(cols.id.primaryKey).toBe(true);
    expect(cols.id.hasDefault).toBe(true);
    expect(cols.email.notNull).toBe(true);
    expect(cols.email.unique).toBe(true);
    expect(cols.name.notNull).toBe(false);
  });

  it("populates an engine table handle per column", () => {
    expect(schema.$tables.users.$columns.id.engineColumn).toBeDefined();
  });
});

describe("defineSchema — engine maps (no relations)", () => {
  const schema = defineSchema((t) => ({
    users: t.table("users", { id: id() }),
    tags: t.table("tags", { id: id(), label: text() }),
  }));

  it("$engine carries a handle per table", () => {
    expect(Object.keys(schema.$engine).sort()).toEqual(["tags", "users"]);
  });

  it("leaves $relations empty on every table", () => {
    for (const tbl of Object.values(schema.$tables)) {
      const relations: ResolvedRelation[] = tbl.$relations;
      expect(relations).toEqual([]);
    }
  });
});

describe("defineSchema — engine maps (with relations)", () => {
  const schema = defineSchema((t) => ({
    users: t.table("users", { id: id() }),
    posts: t.table("posts", {
      id: id(),
      authorId: fk(() => ({
        __isColumnRef: true,
        tableName: "users",
        columnName: "id",
      })),
    }),
  }));

  it("$engine carries only the table handles", () => {
    expect(Object.keys(schema.$engine).sort()).toEqual(["posts", "users"]);
  });

  it("resolves the forward toOne on the FK owner", () => {
    const relations: ResolvedRelation[] = schema.$tables.posts.$relations;
    expect(relations).toEqual([
      {
        name: "users",
        cardinality: "toOne",
        localColumn: "authorId",
        targetTable: "users",
        targetColumn: "id",
        inferred: false,
      },
    ]);
  });

  it("infers the reverse toMany on the FK target", () => {
    const relations: ResolvedRelation[] = schema.$tables.users.$relations;
    expect(relations).toEqual([
      {
        name: "posts",
        cardinality: "toMany",
        localColumn: "id",
        targetTable: "posts",
        targetColumn: "authorId",
        inferred: true,
      },
    ]);
  });
});

describe("defineSchema — typed builder surface", () => {
  it("accepts a typed SchemaBuilderContext callback", () => {
    const build = (t: SchemaBuilderContext) => {
      const users: TableHandle<{ id: ColumnBuilder; email: ColumnBuilder }> =
        t.table("users", { id: id(), email: text() });
      return { users };
    };
    const schema = defineSchema(build);
    expect(schema.$tables.users.$name).toBe("users");
  });
});

describe("defineSchema — custom schemaName", () => {
  it("threads schemaName onto the schema and tables", () => {
    const options: DefineSchemaOptions = { schemaName: "app" };
    const schema = defineSchema(
      (t) => ({ users: t.table("users", { id: id() }) }),
      options,
    );
    expect(schema.$schemaName).toBe("app");
    expect(schema.$tables.users.$schemaName).toBe("app");
  });
});

describe("defineSchema — foreign keys", () => {
  it("forward FK mirrors a serial PK to integer storage", () => {
    const schema = defineSchema((t) => {
      const users = t.table("users", { id: id(), email: text() });
      const posts = t.table("posts", {
        id: id(),
        authorId: fk(() => users.id).notNull(),
      });
      return { users, posts };
    });
    const authorId = schema.$tables.posts.$columns.authorId;
    expect(authorId.storageKind).toBe("integer");
    expect(authorId.pgType).toBe("int4");
    expect(authorId.notNull).toBe(true);
    expect(authorId.fk).toEqual({
      targetTable: "users",
      targetColumn: "id",
      onDelete: undefined,
      onUpdate: undefined,
    });
  });

  it("forward FK to a bigid PK mirrors to bigint storage", () => {
    const schema = defineSchema((t) => {
      const orgs = t.table("orgs", { id: bigid() });
      const teams = t.table("teams", { id: id(), orgId: fk(() => orgs.id) });
      return { orgs, teams };
    });
    const orgId = schema.$tables.teams.$columns.orgId;
    expect(orgId.storageKind).toBe("bigint");
    expect(orgId.pgType).toBe("int8");
    expect(orgId.kind).toBe("bigint");
  });

  it("supports self-referencing FKs", () => {
    const schema = defineSchema((t) => {
      const nodes = t.table("nodes", {
        id: id(),
        // self-ref via a direct ColumnRef thunk (avoids circular type inference).
        parentId: fk(() => ({
          __isColumnRef: true,
          tableName: "nodes",
          columnName: "id",
        })),
      });
      return { nodes };
    });
    expect(schema.$tables.nodes.$columns.parentId.fk?.targetTable).toBe(
      "nodes",
    );
  });

  it("carries onDelete/onUpdate referential actions onto the edge", () => {
    const schema = defineSchema((t) => {
      const users = t.table("users", { id: id() });
      const posts = t.table("posts", {
        id: id(),
        authorId: fk(() => users.id)
          .onDelete("cascade")
          .onUpdate("restrict"),
      });
      return { users, posts };
    });
    expect(schema.$tables.posts.$columns.authorId.fk).toMatchObject({
      onDelete: "cascade",
      onUpdate: "restrict",
    });
  });

  it("throws when fk() targets an unknown table", () => {
    expect(() =>
      defineSchema((t) => ({
        posts: t.table("posts", {
          id: id(),
          ghost: fk(() => ({
            __isColumnRef: true,
            tableName: "missing",
            columnName: "id",
          })),
        }),
      })),
    ).toThrow(/unknown table "missing"/);
  });

  it("throws when fk() targets an unknown column", () => {
    expect(() =>
      defineSchema((t) => {
        const users = t.table("users", { id: id() });
        const posts = t.table("posts", {
          id: id(),
          ghost: fk(() => ({
            __isColumnRef: true,
            tableName: "users",
            columnName: "nope",
          })),
        });
        return { users, posts };
      }),
    ).toThrow(/unknown column "users\.nope"/);
  });
});

describe("defineSchema — guard rails", () => {
  it("throws on duplicate table names", () => {
    expect(() =>
      defineSchema((t) => {
        const a = t.table("users", { id: id() });
        const b = t.table("users", { id: id() });
        return { a, b };
      }),
    ).toThrow(/Duplicate table "users"/);
  });

  it("throws when a returned value did not come from ctx.table()", () => {
    const rogue = {
      $name: "rogue",
      $schemaName: "public",
      $columns: {},
      $relations: [],
    } as unknown as AppKitTable;
    expect(() =>
      defineSchema((t) => {
        t.table("users", { id: id() });
        return { rogue };
      }),
    ).toThrow(/was not produced by ctx\.table\(\)/);
  });
});

describe("defineSchema — real engine wiring (getTableConfig)", () => {
  const schema = defineSchema((t) => {
    const users = t.table("users", {
      id: id(),
      email: text().notNull(),
      active: boolean().default(true),
      createdAt: timestamp().defaultNow(),
    });
    const posts = t.table("posts", {
      id: id(),
      authorId: fk(() => users.id)
        .notNull()
        .onDelete("cascade"),
      views: integer().default(0),
    });
    return { users, posts };
  });

  it("emits a real FK with the correct local/target columns and action", () => {
    const config = getTableConfig(pgOf(schema.$tables.posts.$engine));
    expect(config.foreignKeys).toHaveLength(1);
    const fkConfig = config.foreignKeys[0];
    const ref = fkConfig.reference();
    expect(ref.columns.map((c) => c.name)).toEqual(["authorId"]);
    expect(ref.foreignColumns.map((c) => c.name)).toEqual(["id"]);
    expect(fkConfig.onDelete).toBe("cascade");
  });

  it("wires column names and notNull onto the engine table", () => {
    const config = getTableConfig(pgOf(schema.$tables.users.$engine));
    const byName = Object.fromEntries(config.columns.map((c) => [c.name, c]));
    expect(Object.keys(byName).sort()).toEqual([
      "active",
      "createdAt",
      "email",
      "id",
    ]);
    expect(byName.email.notNull).toBe(true);
    // identity PK is tracked in our ColumnMeta, not pushed onto the serial builder.
    expect(schema.$tables.users.$columns.id.primaryKey).toBe(true);
  });
});
