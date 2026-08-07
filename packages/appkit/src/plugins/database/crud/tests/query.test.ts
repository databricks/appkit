import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIMIT,
  IN_CAP,
  MAX_LIMIT,
} from "../../../../database/contract";
import { DatabasePluginError } from "../../../../database/errors";
import {
  boolean,
  type ColumnRef,
  defineSchema,
  fk,
  id,
  integer,
  jsonb,
  type SchemaBuilderContext,
  text,
  timestamp,
} from "../../../../database/schema-builder";
import { MAX_OFFSET, MAX_QUERY_BYTES } from "../../defaults";
import { type CrudTable, compileCrudTables } from "../contract";
import { decodeDetailQuery, decodeListQuery } from "../query";

const schema = defineSchema((builder) => {
  const users = builder.table("users", {
    id: id(),
    name: text(),
    rank: integer(),
    active: boolean().notNull(),
    createdAt: timestamp(),
    profile: jsonb(),
    token: text().private(),
  });
  const notes = builder.table("notes", {
    id: id(),
    authorId: fk(() => users.id),
    body: text(),
  });
  return { users, notes };
});

const tables = compileCrudTables(schema.$tables);
const users = tables.get("users") as CrudTable;

function query(params: Record<string, unknown>): string {
  const encoded = Object.entries(params).map(
    ([key, value]): [string, string] => [
      key,
      typeof value === "string" ? value : JSON.stringify(value),
    ],
  );
  return new URLSearchParams(encoded).toString();
}

function expectRejected(raw: string): void {
  expect(() => decodeListQuery(users, raw)).toThrow(DatabasePluginError);
  expect(() => decodeListQuery(users, raw)).toThrow(
    expect.objectContaining({ category: "INVALID_REQUEST", statusCode: 400 }),
  );
}

describe("query parameters", () => {
  it("defaults pagination and accepts canonical integers", () => {
    expect(decodeListQuery(users, "")).toEqual({
      where: undefined,
      order: undefined,
      select: undefined,
      include: undefined,
      limit: DEFAULT_LIMIT,
      offset: 0,
    });
    expect(decodeListQuery(users, "limit=10&offset=20")).toMatchObject({
      limit: 10,
      offset: 20,
    });
  });

  it("rejects unknown, repeated, oversized, and non-canonical parameters", () => {
    expectRejected("unknown=1");
    // A generated list is one page query, so there is no total to request.
    expectRejected("includeTotal=true");
    expectRejected("limit=1&limit=2");
    expectRejected(`select=${"x".repeat(MAX_QUERY_BYTES)}`);
    expectRejected("limit=01");
    expectRejected("limit=-1");
    expectRejected("limit=1.0");
    expectRejected(`limit=${MAX_LIMIT + 1}`);
    expectRejected(`offset=${MAX_OFFSET + 1}`);
    expectRejected("where=notjson");
  });

  it("keeps detail requests to projection and includes", () => {
    expect(decodeDetailQuery(users, query({ select: ["id"] }))).toEqual({
      select: ["id"],
      include: undefined,
    });
    expect(() => decodeDetailQuery(users, query({ where: { id: 1 } }))).toThrow(
      DatabasePluginError,
    );
    expect(() => decodeDetailQuery(users, "limit=1")).toThrow(
      DatabasePluginError,
    );
  });
});

describe("select and order", () => {
  it("accepts public columns only", () => {
    expect(
      decodeListQuery(users, query({ select: ["id", "name"] })).select,
    ).toEqual(["id", "name"]);
    expect(
      decodeListQuery(users, query({ order: { name: "desc" } })).order,
    ).toEqual({ name: "desc" });
  });

  it("rejects private, unknown, empty, and unorderable selections", () => {
    expectRejected(query({ select: ["token"] }));
    expectRejected(query({ select: ["missing"] }));
    expectRejected(query({ select: [] }));
    expectRejected(query({ select: "id" }));
    expectRejected(query({ order: { token: "asc" } }));
    expectRejected(query({ order: { profile: "asc" } }));
    expectRejected(query({ order: { name: "sideways" } }));
    expectRejected(query({ order: {} }));
  });
});

describe("where", () => {
  it("decodes operands through their column codec", () => {
    expect(
      decodeListQuery(users, query({ where: { rank: "3" } })).where,
    ).toEqual({ rank: 3 });
    expect(
      decodeListQuery(users, query({ where: { name: { ilike: "a%" } } })).where,
    ).toEqual({ name: { ilike: "a%" } });
    expect(
      decodeListQuery(users, query({ where: { name: { is: null } } })).where,
    ).toEqual({ name: { is: null } });
    expect(
      decodeListQuery(
        users,
        query({
          where: { or: [{ rank: { gte: 1 } }, { id: { in: [1, 2] } }] },
        }),
      ).where,
    ).toEqual({ or: [{ rank: { gte: 1 } }, { id: { in: [1, 2] } }] });
  });

  it("applies one operator matrix per column kind", () => {
    expectRejected(query({ where: { name: { gt: "a" } } }));
    expectRejected(query({ where: { rank: { like: "1" } } }));
    expectRejected(query({ where: { profile: { eq: {} } } }));
    expectRejected(query({ where: { rank: "abc" } }));
    expectRejected(query({ where: { createdAt: { gt: "yesterday" } } }));
  });

  it("keeps null matching explicit and bounds in lists", () => {
    // An empty set is a legal filter that the engine renders as no match.
    expect(
      decodeListQuery(users, query({ where: { id: { in: [] } } })).where,
    ).toEqual({ id: { in: [] } });
    expectRejected(query({ where: { name: null } }));
    expectRejected(query({ where: { name: { eq: null } } }));
    expectRejected(query({ where: { active: { is: null } } }));
    expectRejected(query({ where: { name: { in: ["a", null] } } }));
    expectRejected(
      query({
        where: { id: { in: Array.from({ length: IN_CAP + 1 }, (_, i) => i) } },
      }),
    );
  });

  it("rejects unknown columns, relations, and empty filters", () => {
    expectRejected(query({ where: { missing: 1 } }));
    expectRejected(query({ where: { token: "secret" } }));
    expectRejected(query({ where: { notes: { some: { body: "a" } } } }));
    expectRejected(query({ where: { name: {} } }));
    expectRejected(query({ where: { and: [] } }));
    expectRejected(query({ where: [] }));
  });

  it("bounds nesting, group size, and total conditions", () => {
    let deep: Record<string, unknown> = { rank: 1 };
    for (let level = 0; level < 5; level += 1) deep = { and: [deep] };
    expectRejected(query({ where: deep }));
    expectRejected(
      query({ where: { or: Array.from({ length: 21 }, () => ({ rank: 1 })) } }),
    );
    expectRejected(
      query({
        where: {
          and: Array.from({ length: 20 }, () => ({
            rank: { gt: 1, lt: 5, gte: 1 },
          })),
        },
      }),
    );
  });
});

describe("include", () => {
  it("bounds to-many relations and carries a second edge", () => {
    expect(
      decodeListQuery(users, query({ include: { notes: true } })).include,
    ).toEqual({ notes: { limit: DEFAULT_LIMIT } });
    expect(
      decodeListQuery(
        users,
        query({
          include: {
            notes: { select: ["body"], limit: 5, include: { users: true } },
          },
        }),
      ).include,
    ).toEqual({
      notes: { select: ["body"], limit: 5, include: { users: true } },
    });
  });

  it("rejects a third edge, unknown relations, and unsupported options", () => {
    expectRejected(
      query({ include: { notes: { include: { users: { include: {} } } } } }),
    );
    expectRejected(query({ include: { missing: true } }));
    expectRejected(query({ include: { notes: false } }));
    expectRejected(query({ include: { notes: { offset: 1 } } }));
    expectRejected(query({ include: { notes: { limit: MAX_LIMIT + 1 } } }));
    expectRejected(query({ include: { notes: { select: ["missing"] } } }));
  });

  it("limits only to-many relations and scopes options to the target", () => {
    const notes = tables.get("notes") as CrudTable;
    expect(() =>
      decodeListQuery(notes, query({ include: { users: { limit: 1 } } })),
    ).toThrow(DatabasePluginError);
    expect(
      decodeListQuery(
        notes,
        query({ include: { users: { where: { rank: 1 } } } }),
      ).include,
    ).toEqual({ users: { where: { rank: 1 } } });
    expect(() =>
      decodeListQuery(
        notes,
        query({ include: { users: { where: { body: "a" } } } }),
      ),
    ).toThrow(DatabasePluginError);
  });
});

describe("read budget", () => {
  it("rejects fan-out before the entity terminal runs", () => {
    expectRejected(
      query({ limit: "500", include: { notes: { limit: MAX_LIMIT } } }),
    );
    expectRejected(
      query({
        limit: "50",
        include: { notes: { limit: 100, include: { users: true } } },
      }),
    );
    expect(
      decodeListQuery(
        users,
        query({
          limit: "49",
          include: { notes: { limit: 100, include: { users: true } } },
        }),
      ).limit,
    ).toBe(49);
  });

  it("bounds the total number of relation nodes in one tree", () => {
    const wide = defineSchema((builder: SchemaBuilderContext) => {
      const shared = builder.table("shared", { id: id() });
      const leaves: Record<string, { id: ColumnRef }> = {};
      for (let index = 0; index < 9; index += 1) {
        leaves[`t${index}`] = builder.table(`t${index}`, {
          id: id(),
          sharedId: fk(() => shared.id),
        });
      }
      const hub = builder.table("hub", {
        id: id(),
        ...Object.fromEntries(
          Object.entries(leaves).map(([name, leaf]) => [
            `${name}Id`,
            fk(() => leaf.id),
          ]),
        ),
      });
      return { shared, ...leaves, hub };
    });
    const hub = compileCrudTables(wide.$tables).get("hub") as CrudTable;
    const branch = { include: { shared: true, hub: { limit: 0 } } };
    const tree = (count: number) =>
      query({
        limit: "1",
        include: Object.fromEntries(
          Array.from({ length: count }, (_, index) => [`t${index}`, branch]),
        ),
      });

    // 8 branches materialize 24 relation nodes; a ninth crosses the 25 cap.
    expect(
      Object.keys(decodeListQuery(hub, tree(8)).include ?? {}),
    ).toHaveLength(8);
    expect(() => decodeListQuery(hub, tree(9))).toThrow(DatabasePluginError);
  });
});
