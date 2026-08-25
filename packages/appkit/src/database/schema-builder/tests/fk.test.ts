import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { mirrorStorageKind, resolveFkRef } from "../fk";
import {
  bigint,
  type ColumnBuilder,
  type ColumnRef,
  defineSchema,
  enumColumn,
  fk,
  id,
  type StorageKind,
  type TableHandle,
  text,
  timestamp,
  uuid,
  varchar,
} from "../index";
import type { EngineTable } from "../types";

const pgOf = (table: EngineTable): PgTable => table as unknown as PgTable;
const ref: ColumnRef = Object.freeze({
  __isColumnRef: true,
  tableName: "users",
  columnName: "id",
});

describe("fk references", () => {
  it("stores direct and deferred references without resolving early", () => {
    expect(fk(ref)._meta.fkRef).toBe(ref);
    expect(typeof fk(() => ref)._meta.fkRef).toBe("function");
    expect(resolveFkRef(ref)).toBe(ref);
    expect(resolveFkRef(() => ref)).toBe(ref);
  });

  it("rejects malformed references", () => {
    expect(() => resolveFkRef({} as ColumnRef)).toThrow(
      /must reference a column/,
    );
  });
});

describe("foreign-key storage and target invariants", () => {
  it("mirrors generated identities to non-generated integer storage", () => {
    expect(mirrorStorageKind("id")).toBe("integer");
    expect(mirrorStorageKind("bigid")).toBe("bigint");
    expect(mirrorStorageKind("uuid")).toBe("uuid");
  });

  it("inherits the complete target storage contract", () => {
    const schema = defineSchema((builder) => {
      const integer_targets = builder.table("integer_targets", { id: id() });
      const uuid_targets = builder.table("uuid_targets", {
        value: uuid().unique(),
      });
      const varchar_targets = builder.table("varchar_targets", {
        value: varchar(32).unique(),
      });
      const timestamp_targets = builder.table("timestamp_targets", {
        value: timestamp({ withTimezone: true }).unique(),
      });
      const bigint_targets = builder.table("bigint_targets", {
        value: bigint().unique(),
      });
      const enum_targets = builder.table("enum_targets", {
        value: enumColumn("target_status", ["open", "closed"]).unique(),
      });
      const references = builder.table("references", {
        id: id(),
        targetId: fk(() => integer_targets.id),
        externalId: fk(() => uuid_targets.value),
        code: fk(() => varchar_targets.value),
        happenedAt: fk(() => timestamp_targets.value),
        ordinal: fk(() => bigint_targets.value),
        status: fk(() => enum_targets.value),
      });
      return {
        integer_targets,
        uuid_targets,
        varchar_targets,
        timestamp_targets,
        bigint_targets,
        enum_targets,
        references,
      };
    });

    const columns = schema.$tables.references.$columns;
    expect(columns.targetId).toMatchObject({
      storageKind: "integer",
      kind: "number",
    });
    expect(columns.externalId).toMatchObject({
      storageKind: "uuid",
      kind: "uuid",
    });
    expect(columns.code).toMatchObject({
      storageKind: "varchar",
      varcharLength: 32,
    });
    expect(columns.happenedAt).toMatchObject({
      storageKind: "timestamp",
      withTimezone: true,
      kind: "date",
    });
    expect(columns.ordinal).toMatchObject({
      storageKind: "bigint",
      kind: "bigint",
    });
    expect(columns.status).toMatchObject({
      storageKind: "enum",
      enumName: "target_status",
      enumValues: ["open", "closed"],
    });
  });

  it("resolves chained FK storage independently of declaration order", () => {
    const schema = defineSchema((builder) => {
      let middle: TableHandle<{ leafId: ColumnBuilder }>;
      let leaf: TableHandle<{ id: ColumnBuilder }>;
      const root = builder.table("root", {
        middleId: fk(() => middle.leafId),
      });
      middle = builder.table("middle", {
        leafId: fk(() => leaf.id).unique(),
      });
      leaf = builder.table("leaf", { id: uuid().primaryKey() });
      return { root, middle, leaf };
    });

    expect(schema.$tables.middle.$columns.leafId.storageKind).toBe("uuid");
    expect(schema.$tables.root.$columns.middleId.storageKind).toBe("uuid");
    const [foreignKey] = getTableConfig(
      pgOf(schema.$tables.root.$engine),
    ).foreignKeys;
    expect(foreignKey.reference().foreignColumns[0].name).toBe("leafId");
  });

  it("rejects FK storage cycles that have no concrete target type", () => {
    expect(() =>
      defineSchema((builder) => {
        let left: TableHandle<{ rightId: ColumnBuilder }>;
        const right = builder.table("right", {
          leftId: fk(() => left.rightId).unique(),
        });
        left = builder.table("left", {
          rightId: fk(() => right.leftId).unique(),
        });
        return { left, right };
      }),
    ).toThrow(/cyclic storage dependency/);
  });

  it("requires a primary-key or unique target", () => {
    expect(() =>
      defineSchema((builder) => {
        const users = builder.table("users", { id: id(), email: text() });
        const notes = builder.table("notes", {
          userEmail: fk(() => users.email),
        });
        return { users, notes };
      }),
    ).toThrow(/primary-key or unique/);
  });

  it("rejects unknown, cross-schema, and omitted targets", () => {
    expect(() =>
      defineSchema((builder) => ({
        notes: builder.table("notes", {
          userId: fk(() => ({
            __isColumnRef: true,
            tableName: "missing",
            columnName: "id",
          })),
        }),
      })),
    ).toThrow(/outside the returned schema/);

    let externalUsers!: TableHandle<{ id: ColumnBuilder }>;
    defineSchema((builder) => {
      externalUsers = builder.table("users", { id: id() });
      return { users: externalUsers };
    });
    expect(() =>
      defineSchema((builder) => ({
        notes: builder.table("notes", {
          userId: fk(() => externalUsers.id),
        }),
      })),
    ).toThrow(/outside the returned schema/);

    expect(() =>
      defineSchema((builder) => {
        const users = builder.table("users", { id: id() });
        const notes = builder.table("notes", {
          userId: fk(() => externalUsers.id),
        });
        return { users, notes };
      }),
    ).toThrow(/outside the returned schema/);

    expect(() =>
      defineSchema((builder) => {
        const users = builder.table("users", { id: id() });
        const notes = builder.table("notes", { userId: fk(() => users.id) });
        return { notes };
      }),
    ).toThrow(/omitted declared table: users/);
  });
});

describe("referential-action coherence", () => {
  it("allows SET NULL only on nullable foreign keys", () => {
    expect(() =>
      defineSchema((builder) => {
        const users = builder.table("users", { id: id() });
        const notes = builder.table("notes", {
          userId: fk(() => users.id).onDelete("set null"),
        });
        return { users, notes };
      }),
    ).not.toThrow();

    expect(() =>
      defineSchema((builder) => {
        const users = builder.table("users", { id: id() });
        const notes = builder.table("notes", {
          userId: fk(() => users.id)
            .notNull()
            .onDelete("set null"),
        });
        return { users, notes };
      }),
    ).toThrow(/SET NULL but is not-null/);
  });

  it("allows SET DEFAULT only with a compatible local default", () => {
    expect(() =>
      defineSchema((builder) => {
        const users = builder.table("users", { id: id() });
        const notes = builder.table("notes", {
          userId: fk(() => users.id)
            .default(0)
            .onDelete("set default"),
        });
        return { users, notes };
      }),
    ).not.toThrow();

    expect(() =>
      defineSchema((builder) => {
        const users = builder.table("users", { id: id() });
        const notes = builder.table("notes", {
          userId: fk(() => users.id).onUpdate("set default"),
        });
        return { users, notes };
      }),
    ).toThrow(/SET DEFAULT without a local default/);
  });

  it("validates literal defaults after inheriting the target storage", () => {
    expect(() =>
      defineSchema((builder) => {
        const users = builder.table("users", {
          externalId: uuid().unique(),
        });
        const notes = builder.table("notes", {
          userId: fk(() => users.externalId).default(1),
        });
        return { users, notes };
      }),
    ).toThrow(/not compatible with uuid storage/);

    expect(() =>
      defineSchema((builder) => {
        const statuses = builder.table("statuses", {
          value: enumColumn("status_kind", ["open", "closed"]).unique(),
        });
        const records = builder.table("records", {
          status: fk(() => statuses.value).default("missing"),
        });
        return { statuses, records };
      }),
    ).toThrow(/not compatible with enum storage/);
  });

  it("materializes validated foreign keys and actions in Drizzle", () => {
    const schema = defineSchema((builder) => {
      const users = builder.table("users", { id: id() });
      const notes = builder.table("notes", {
        id: id(),
        userId: fk(() => users.id)
          .notNull()
          .onDelete("cascade")
          .onUpdate("restrict"),
      });
      return { users, notes };
    });
    const [foreignKey] = getTableConfig(
      pgOf(schema.$tables.notes.$engine),
    ).foreignKeys;
    const reference = foreignKey.reference();
    expect(reference.columns.map((column) => column.name)).toEqual(["userId"]);
    expect(reference.foreignColumns.map((column) => column.name)).toEqual([
      "id",
    ]);
    expect(foreignKey.onDelete).toBe("cascade");
    expect(foreignKey.onUpdate).toBe("restrict");
  });
});

describe("StorageKind", () => {
  it("keeps the supported inherited kinds", () => {
    const kind: StorageKind = mirrorStorageKind("text");
    expect(kind).toBe("text");
  });
});
