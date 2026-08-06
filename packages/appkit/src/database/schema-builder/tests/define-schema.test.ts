import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  bigid,
  bigint,
  boolean,
  type ColumnBuilder,
  type DefineSchemaOptions,
  defineSchema,
  enumColumn,
  fk,
  id,
  integer,
  jsonb,
  type Schema,
  type SchemaBuilderContext,
  type TableHandle,
  text,
  timestamp,
  uuid,
  varchar,
} from "../index";
import type { EngineTable } from "../types";

const pgOf = (table: EngineTable): PgTable => table as unknown as PgTable;

describe("defineSchema finalization", () => {
  it.each(["sql", "transaction"])(
    "rejects DatabaseExports root key %s",
    (name) => {
      expect(() =>
        defineSchema(({ table }) => {
          const reserved = table(name, { value: text() });
          return { [name]: reserved };
        }),
      ).toThrow(/reserved/);
    },
  );

  const schema = defineSchema((builder) => ({
    users: builder.table("users", {
      id: id(),
      email: text().notNull().unique(),
      name: text(),
    }),
  }));

  it("preserves literal table keys and canonical identity", () => {
    expectTypeOf(schema.$tables).toHaveProperty("users");
    expect(schema.$tables.users.$name).toBe("users");
    expect(Object.keys(schema.$tables)).toEqual(["users"]);
    expect(Object.keys(schema.$tables.users)).toEqual(["id", "email", "name"]);
  });

  it("publishes complete immutable metadata", () => {
    const users = schema.$tables.users;
    expect(Object.isFrozen(schema)).toBe(true);
    expect(Object.isFrozen(schema.$tables)).toBe(true);
    expect(Object.isFrozen(schema.$engine)).toBe(true);
    expect(Object.isFrozen(users)).toBe(true);
    expect(Object.isFrozen(users.$columns)).toBe(true);
    expect(Object.isFrozen(users.$columns.id)).toBe(true);
    expect(Object.isFrozen(users.$relations)).toBe(true);
    expect(users.$insertSchema).toBeDefined();
    expect(users.$updateSchema).toBeDefined();

    expect(() => {
      (users.$columns as Record<string, unknown>).rogue = {};
    }).toThrow(TypeError);
    expect(() => {
      (schema.$tables as Record<string, unknown>).rogue = users;
    }).toThrow(TypeError);
  });

  it("uses collision-safe registries", () => {
    expect(Object.getPrototypeOf(schema.$tables)).toBeNull();
    expect(Object.getPrototypeOf(schema.$engine)).toBeNull();
    expect(Object.getPrototypeOf(schema.$tables.users.$columns)).toBeNull();
  });

  it("defaults to public and supports a safe custom schema", () => {
    expect(schema.$schemaName).toBe("public");
    const options: DefineSchemaOptions = { schemaName: "application" };
    const custom = defineSchema(
      (builder) => ({ widgets: builder.table("widgets", { id: id() }) }),
      options,
    );
    expect(custom.$schemaName).toBe("application");
    expect(custom.$tables.widgets.$schemaName).toBe("application");
  });

  it("accepts the explicit builder context type", () => {
    const build = (builder: SchemaBuilderContext) => {
      const users: TableHandle<{ id: ColumnBuilder; email: ColumnBuilder }> =
        builder.table("users", { id: id(), email: text() });
      return { users };
    };
    const typed: Schema = defineSchema(build);
    expect(typed.$tables.users.$name).toBe("users");
  });

  it("allows an explicitly empty schema", () => {
    const empty = defineSchema(() => ({}));
    expect(empty.$tables).toEqual({});
    expect(empty.$engine).toEqual({});
    expect(Object.isFrozen(empty)).toBe(true);
  });

  it("does not partially finalize handles when declaration validation fails", () => {
    let firstHandle: TableHandle<{ id: ColumnBuilder }> | undefined;
    expect(() =>
      defineSchema((builder) => {
        const first = builder.table("first", { id: id() });
        const second = builder.table("second", { id: id() });
        firstHandle = first;
        Object.preventExtensions(second);
        return { first, second };
      }),
    ).toThrow(/modified during schema declaration/);
    if (!firstHandle)
      throw new Error("fixture did not retain the first handle");
    expect("$name" in firstHandle).toBe(false);
  });
});

describe("canonical table identity", () => {
  it("requires every declared table exactly once", () => {
    expect(() =>
      defineSchema((builder) => {
        const users = builder.table("users", { id: id() });
        builder.table("omitted", { id: id() });
        return { users };
      }),
    ).toThrow(/omitted declared table: omitted/);
  });

  it("rejects aliases and duplicate handles", () => {
    expect(() =>
      defineSchema((builder) => {
        const users = builder.table("users", { id: id() });
        return { people: users };
      }),
    ).toThrow(/aliases are not supported/);

    expect(() =>
      defineSchema((builder) => {
        const users = builder.table("users", { id: id() });
        return { users, duplicate: users };
      }),
    ).toThrow(/aliases are not supported|returned more than once/);
  });

  it("rejects foreign values and duplicate table declarations", () => {
    expect(() =>
      defineSchema((builder) => {
        builder.table("users", { id: id() });
        return { rogue: {} as never };
      }),
    ).toThrow(/was not produced by ctx\.table/);
    expect(() =>
      defineSchema((builder) => {
        const first = builder.table("users", { id: id() });
        builder.table("users", { id: id() });
        return { users: first };
      }),
    ).toThrow(/Duplicate table/);
  });

  it("allows ordinary quoted names while rejecting concrete runtime collisions", () => {
    const quoted = defineSchema((builder) => ({
      toString: builder.table("toString", { displayName: text() }),
    }));
    expect(Object.values(quoted.$tables)[0].$name).toBe("toString");

    expect(() =>
      defineSchema((builder) => ({
        users: builder.table("users", { and: text() }),
      })),
    ).toThrow(/runtime metadata/);

    const reservedColumns = Object.create(null) as Record<
      string,
      ColumnBuilder
    >;
    reservedColumns.__proto__ = text();
    expect(() =>
      defineSchema((builder) => ({
        users: builder.table("users", reservedColumns),
      })),
    ).toThrow(/reserved/);
  });
});

describe("primary-key invariants and Drizzle agreement", () => {
  it.each([
    ["id", id()],
    ["bigid", bigid()],
  ])("emits %s as an actual identity primary key", (_name, key) => {
    const schema = defineSchema((builder) => ({
      records: builder.table("records", { key }),
    }));
    const config = getTableConfig(pgOf(schema.$tables.records.$engine));
    const column = config.columns[0];
    expect(column.primary).toBe(true);
    expect(column.notNull).toBe(true);
    expect(column.generatedIdentity).toMatchObject({ type: "byDefault" });
    expect(schema.$tables.records.$columns.key.primaryKey).toBe(true);
  });

  it("supports keyless and one application-assigned primary key", () => {
    const schema = defineSchema((builder) => ({
      events: builder.table("events", { body: text().notNull() }),
      accounts: builder.table("accounts", {
        slug: text().primaryKey(),
        label: text(),
      }),
    }));
    expect(
      Object.values(schema.$tables.events.$columns).some(
        (column) => column.primaryKey,
      ),
    ).toBe(false);
    const config = getTableConfig(pgOf(schema.$tables.accounts.$engine));
    const slug = config.columns.find((column) => column.name === "slug");
    expect(slug?.primary).toBe(true);
    expect(slug?.notNull).toBe(true);
    expect(slug?.generatedIdentity).toBeUndefined();
  });

  it("rejects multiple primary-key markers", () => {
    expect(() =>
      defineSchema((builder) => ({
        invalid: builder.table("invalid", {
          first: text().primaryKey(),
          second: integer().primaryKey(),
        }),
      })),
    ).toThrow(/multiple primary-key columns/);
  });
});

describe("builder reuse and engine metadata", () => {
  it("clones builder state across columns and schemas", () => {
    const shared = text();
    const first = defineSchema((builder) => ({
      first: builder.table("first", { left: shared, right: shared }),
    }));
    shared.private().default("later");
    const second = defineSchema((builder) => ({
      second: builder.table("second", { value: shared }),
    }));

    expect(first.$tables.first.$columns.left.isPrivate).toBe(false);
    expect(first.$tables.first.$columns.right.hasDefault).toBe(false);
    expect(second.$tables.second.$columns.value.isPrivate).toBe(true);
    expect(second.$tables.second.$columns.value.defaultValue).toBe("later");
    expect(first.$tables.first.$columns.left).not.toBe(
      first.$tables.first.$columns.right,
    );
    expect(first.$tables.first.$columns.left.engineColumn).not.toBe(
      second.$tables.second.$columns.value.engineColumn,
    );
  });

  it("materializes defaults in Drizzle configuration", () => {
    const schema = defineSchema((builder) => ({
      records: builder.table("records", {
        id: id(),
        active: boolean().default(true),
        count: integer().default(0),
        createdAt: timestamp().defaultNow(),
      }),
    }));
    const columns = Object.fromEntries(
      getTableConfig(pgOf(schema.$tables.records.$engine)).columns.map(
        (column) => [column.name, column],
      ),
    );
    expect(columns.active.default).toBe(true);
    expect(columns.count.default).toBe(0);
    expect(columns.createdAt.hasDefault).toBe(true);
  });

  it("keeps timestamp values in the declared string runtime representation", () => {
    const value = "2024-01-02T03:04:05Z";
    const schema = defineSchema((builder) => ({
      records: builder.table("records", {
        occurredAt: timestamp().default(value),
      }),
    }));
    const [column] = getTableConfig(
      pgOf(schema.$tables.records.$engine),
    ).columns;
    expect(column.mapToDriverValue(value as never)).toBe(value);
    expect(column.default).toBe(value);
  });

  it.each([
    // text protocol, as a direct select returns it
    ["2026-06-29 19:05:19.051709+00", "2026-06-29T19:05:19.051709+00:00"],
    ["2026-06-29 19:05:19+05:30", "2026-06-29T19:05:19+05:30"],
    ["2026-06-29 19:05:19-03", "2026-06-29T19:05:19-03:00"],
    // JSON aggregate, as a relation include returns it
    ["2026-06-29T19:05:19.051709+00:00", "2026-06-29T19:05:19.051709+00:00"],
    // no timezone declared
    ["2026-06-29 19:05:19.051709", "2026-06-29T19:05:19.051709"],
    // non-timestamp sentinels stay untouched
    ["infinity", "infinity"],
    ["-infinity", "-infinity"],
  ])("decodes timestamp %s as ISO-8601", (driverValue, expected) => {
    const schema = defineSchema((builder) => ({
      records: builder.table("records", {
        occurredAt: timestamp({ withTimezone: true }),
      }),
    }));
    const [column] = getTableConfig(
      pgOf(schema.$tables.records.$engine),
    ).columns;
    expect(column.mapFromDriverValue(driverValue as never)).toBe(expected);
  });

  it("returns the same timestamp shape from a direct read and a relation", () => {
    const schema = defineSchema((builder) => ({
      records: builder.table("records", {
        occurredAt: timestamp({ withTimezone: true }),
      }),
    }));
    const [column] = getTableConfig(
      pgOf(schema.$tables.records.$engine),
    ).columns;
    const fromSelect = column.mapFromDriverValue(
      "2026-06-29 19:05:19.051709+00" as never,
    );
    const fromInclude = column.mapFromDriverValue(
      "2026-06-29T19:05:19.051709+00:00" as never,
    );
    expect(fromSelect).toBe(fromInclude);
    expect(Number.isNaN(Date.parse(fromSelect as string))).toBe(false);
  });

  it("validates literal defaults against storage and enum values", () => {
    const schema = defineSchema((builder) => ({
      records: builder.table("records", {
        status: enumColumn("record_status", ["open", "closed"]).default("open"),
      }),
    }));
    const [status] = getTableConfig(
      pgOf(schema.$tables.records.$engine),
    ).columns;
    expect(status.default).toBe("open");

    const incompatibleDefaults = [
      text().default(1),
      integer().default("1"),
      integer().default(2_147_483_648),
      boolean().default("true"),
      varchar(3).default("toolong"),
      uuid().default("not-a-uuid"),
      timestamp().default("not-a-timestamp"),
      enumColumn("invalid_status", ["open", "closed"]).default("missing"),
      bigint().default(1),
      jsonb().default("{}"),
    ];
    for (const value of incompatibleDefaults) {
      expect(() =>
        defineSchema((builder) => ({
          records: builder.table("records", { value }),
        })),
      ).toThrow(/not compatible/);
    }
  });
});

describe("enum identity", () => {
  it("reuses equal declarations and rejects conflicting values", () => {
    expect(() =>
      defineSchema((builder) => ({
        first: builder.table("first", {
          status: enumColumn("status_kind", ["open", "closed"]),
        }),
        second: builder.table("second", {
          status: builder.enum("status_kind", ["open", "closed"]),
        }),
      })),
    ).not.toThrow();

    expect(() =>
      defineSchema((builder) => ({
        first: builder.table("first", {
          status: enumColumn("status_kind", ["open", "closed"]),
        }),
        second: builder.table("second", {
          status: enumColumn("status_kind", ["open", "archived"]),
        }),
      })),
    ).toThrow(/conflicting values/);
  });

  it("creates enums in the table's PostgreSQL schema", () => {
    const schema = defineSchema(
      (builder) => ({
        tickets: builder.table("tickets", {
          status: builder.enum("ticket_status", ["open", "closed"]),
        }),
      }),
      { schemaName: "application" },
    );
    const [column] = getTableConfig(
      pgOf(schema.$tables.tickets.$engine),
    ).columns;
    expect(
      (column as unknown as { enum?: { schema?: string } }).enum?.schema,
    ).toBe("application");
    expect(column.enumValues).toEqual(["open", "closed"]);
  });
});

describe("generated relation-key collisions", () => {
  it("rejects a table that would overwrite Drizzle relation metadata", () => {
    expect(() =>
      defineSchema((builder) => {
        const users = builder.table("users", { id: id() });
        const posts = builder.table("posts", {
          id: id(),
          userId: fk(() => users.id),
        });
        const usersRelations = builder.table("usersRelations", { id: id() });
        return { users, posts, usersRelations };
      }),
    ).toThrow(/collides with generated relation metadata/);
  });
});
