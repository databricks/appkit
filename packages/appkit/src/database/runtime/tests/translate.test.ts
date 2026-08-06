import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  IN_CAP,
  MAX_INCLUDES,
  MAX_LIMIT,
  MAX_WHERE_CONDITIONS,
  MAX_WHERE_DEPTH,
  MAX_WHERE_GROUP_ITEMS,
} from "../../contract";
import { DatabasePluginError } from "../../errors";
import {
  bigint,
  boolean,
  defineSchema,
  enumColumn,
  fk,
  id,
  integer,
  jsonb,
  text,
  timestamp,
  uuid,
} from "../../schema-builder";
import { filterOperatorsForKind } from "../../schema-builder/types";
import type { WhereClause } from "../data-path";
import {
  defaultColumns,
  returningColumns,
  selectToColumns,
  translateInclude,
  translateOrder,
  translateWhere,
} from "../engine/translate";

const schema = defineSchema((builder) => {
  const users = builder.table("users", {
    id: id(),
    name: text(),
    age: integer(),
    active: boolean().notNull(),
    large: bigint().notNull(),
    createdAt: timestamp().notNull(),
    externalId: uuid().notNull(),
    status: enumColumn("user_status", ["active", "disabled"]).notNull(),
    metadata: jsonb(),
    secret: text().private(),
  });
  const posts = builder.table("posts", {
    id: id(),
    authorId: fk(() => users.id),
    title: text(),
    secret: text().private(),
  });
  return { users, posts };
});

const users = schema.$tables.users;
const dialect = new PgDialect();

function render(fragment: SQL | undefined): { sql: string; params: unknown[] } {
  if (!fragment) throw new Error("expected SQL fragment");
  const query = dialect.sqlToQuery(fragment);
  return { sql: query.sql, params: query.params as unknown[] };
}

describe("translateWhere", () => {
  it("uses one operator matrix for every column value kind", () => {
    expect(filterOperatorsForKind("string")).toEqual([
      "eq",
      "neq",
      "in",
      "like",
      "ilike",
    ]);
    expect(filterOperatorsForKind("number")).toEqual([
      "eq",
      "neq",
      "in",
      "gt",
      "gte",
      "lt",
      "lte",
    ]);
    expect(filterOperatorsForKind("boolean")).toEqual(["eq", "neq", "in"]);
    expect(filterOperatorsForKind("json")).toEqual([]);
  });

  it("resolves identifiers from metadata and parameterizes values", () => {
    const injected = "x'; drop table users; --";
    const query = render(translateWhere(users, { name: injected }));
    expect(query.sql).toBe(`"users"."name" = $1`);
    expect(query.sql).not.toContain("drop table");
    expect(query.params).toEqual([injected]);
    expect(() => translateWhere(users, { missing: injected })).toThrow(
      DatabasePluginError,
    );
  });

  it("translates the direct-column operator set", () => {
    const checks = [
      [{ age: { eq: 1 } }, `"users"."age" = $1`],
      [{ age: { neq: 1 } }, `"users"."age" <> $1`],
      [{ age: { gt: 1 } }, `"users"."age" > $1`],
      [{ age: { gte: 1 } }, `"users"."age" >= $1`],
      [{ age: { lt: 1 } }, `"users"."age" < $1`],
      [{ age: { lte: 1 } }, `"users"."age" <= $1`],
      [{ name: { like: "a%" } }, `"users"."name" like $1`],
      [{ name: { ilike: "a%" } }, `"users"."name" ilike $1`],
      [{ name: { is: null } }, `"users"."name" is null`],
    ] as const;
    for (const [where, expected] of checks) {
      expect(render(translateWhere(users, where)).sql).toBe(expected);
    }
    expect(() =>
      translateWhere(users, { age: { between: [1, 2] } as never }),
    ).toThrow(DatabasePluginError);
  });

  it("bounds in lists and gives an empty list deterministic semantics", () => {
    const query = render(translateWhere(users, { id: { in: [1, 2, 3] } }));
    expect(query.sql).toBe(`"users"."id" in ($1, $2, $3)`);
    expect(query.params).toEqual([1, 2, 3]);
    expect(render(translateWhere(users, { id: { in: [] } })).sql).toBe("false");
    expect(() =>
      translateWhere(users, {
        id: { in: Array.from({ length: IN_CAP + 1 }, (_, index) => index) },
      }),
    ).toThrow(DatabasePluginError);
    expect(() =>
      translateWhere(users, { name: { in: ["Ada", null] } }),
    ).toThrow(DatabasePluginError);
  });

  it("rejects operators and values that do not match column metadata", () => {
    const validUuid = "123e4567-e89b-12d3-a456-426614174000";
    expect(
      render(translateWhere(users, { externalId: validUuid })).params,
    ).toEqual([validUuid]);
    expect(
      render(
        translateWhere(users, {
          createdAt: { gt: "2020-01-01T00:00:00Z" },
        }),
      ).params,
    ).toEqual(["2020-01-01T00:00:00Z"]);
    expect(render(translateWhere(users, { large: { gt: 5n } })).params).toEqual(
      [5n],
    );

    expect(() =>
      translateWhere(users, { age: { like: "1%" } as never }),
    ).toThrow(DatabasePluginError);
    expect(() =>
      translateWhere(users, { active: { gt: true } as never }),
    ).toThrow(DatabasePluginError);
    expect(() =>
      translateWhere(users, { metadata: { eq: { key: "value" } } as never }),
    ).toThrow(DatabasePluginError);
    expect(() => translateWhere(users, { externalId: "not-a-uuid" })).toThrow(
      DatabasePluginError,
    );
    expect(() =>
      translateWhere(users, { createdAt: { gt: "not-a-timestamp" } }),
    ).toThrow(DatabasePluginError);
    expect(() => translateWhere(users, { status: "unknown" })).toThrow(
      DatabasePluginError,
    );
  });

  it("uses only is:null for nullable matching", () => {
    expect(render(translateWhere(users, { name: { is: null } })).sql).toBe(
      `"users"."name" is null`,
    );
    expect(() => translateWhere(users, { name: null })).toThrow(
      DatabasePluginError,
    );
    expect(() => translateWhere(users, { name: { eq: null } })).toThrow(
      DatabasePluginError,
    );
    expect(() => translateWhere(users, { active: { is: null } })).toThrow(
      DatabasePluginError,
    );
  });

  it("rejects empty logical groups instead of widening a query", () => {
    expect(() => translateWhere(users, { or: [] })).toThrow(
      DatabasePluginError,
    );
    expect(() => translateWhere(users, { and: [{}] })).toThrow(
      DatabasePluginError,
    );
  });

  it("combines and/or groups without relation predicates", () => {
    const query = render(
      translateWhere(users, {
        or: [
          { name: "Ada" },
          { and: [{ age: { gt: 18 } }, { age: { lt: 65 } }] },
        ],
      }),
    );
    expect(query.sql).toContain(" or ");
    expect(query.sql).toContain(" and ");
  });

  it("bounds predicate depth, group width, and aggregate conditions", () => {
    let deepestAllowed: WhereClause = { name: "Ada" };
    for (let depth = 1; depth < MAX_WHERE_DEPTH; depth += 1) {
      deepestAllowed = { and: [deepestAllowed] };
    }
    expect(() => translateWhere(users, deepestAllowed)).not.toThrow();
    expect(() => translateWhere(users, { and: [deepestAllowed] })).toThrow(
      DatabasePluginError,
    );

    const widestAllowed = Array.from({ length: MAX_WHERE_GROUP_ITEMS }, () => ({
      name: "Ada",
    }));
    expect(() => translateWhere(users, { or: widestAllowed })).not.toThrow();
    expect(() =>
      translateWhere(users, {
        or: [...widestAllowed, { name: "Grace" }],
      }),
    ).toThrow(DatabasePluginError);

    const conditionsPerGroup = 3;
    const allowedGroups = Math.floor(MAX_WHERE_CONDITIONS / conditionsPerGroup);
    const conditionGroup = () => ({
      name: { eq: "Ada", neq: "Grace", like: "A%" },
    });
    const exactlyAtLimit = [
      ...Array.from({ length: allowedGroups }, conditionGroup),
      { name: { eq: "Ada", neq: "Grace" } },
    ];
    expect(exactlyAtLimit).toHaveLength(allowedGroups + 1);
    expect(() => translateWhere(users, { and: exactlyAtLimit })).not.toThrow();
    expect(() =>
      translateWhere(users, {
        and: [...exactlyAtLimit, { name: "overflow" }],
      }),
    ).toThrow(DatabasePluginError);
  });
});

describe("ordering and selection", () => {
  it("uses a private-safe default projection", () => {
    expect(defaultColumns(users)).toEqual({
      id: true,
      name: true,
      age: true,
      active: true,
      large: true,
      createdAt: true,
      externalId: true,
      status: true,
      metadata: true,
    });
    expect(returningColumns(users)).toEqual({
      id: users.$columns.id.engineColumn,
      name: users.$columns.name.engineColumn,
      age: users.$columns.age.engineColumn,
      active: users.$columns.active.engineColumn,
      large: users.$columns.large.engineColumn,
      createdAt: users.$columns.createdAt.engineColumn,
      externalId: users.$columns.externalId.engineColumn,
      status: users.$columns.status.engineColumn,
      metadata: users.$columns.metadata.engineColumn,
    });
    expect(returningColumns(users)).not.toHaveProperty("secret");
    expect(returningColumns(users, "trusted")).toHaveProperty(
      "secret",
      users.$columns.secret.engineColumn,
    );
  });

  it("resolves only declared public columns by default", () => {
    const [age, name] = translateOrder(users, { age: "asc", name: "desc" });
    expect(render(age).sql).toBe(`"users"."age" asc`);
    expect(render(name).sql).toBe(`"users"."name" desc`);
    expect(selectToColumns(users, ["id"])).toEqual({ id: true });
    expect(() => selectToColumns(users, ["secret"])).toThrow(
      DatabasePluginError,
    );
    expect(() => translateWhere(users, { secret: "hidden" })).toThrow(
      DatabasePluginError,
    );
    expect(() => translateOrder(users, { secret: "asc" })).toThrow(
      DatabasePluginError,
    );
    expect(() => translateOrder(users, { missing: "asc" })).toThrow(
      DatabasePluginError,
    );
    expect(() => selectToColumns(users, ["missing"])).toThrow(
      DatabasePluginError,
    );
    expect(() => translateOrder(users, { age: "sideways" as "asc" })).toThrow(
      DatabasePluginError,
    );
  });

  it("allows private read operations only with explicit trusted access", () => {
    expect(selectToColumns(users, ["id", "secret"], "trusted")).toEqual({
      id: true,
      secret: true,
    });
    expect(
      render(translateWhere(users, { secret: "hidden" }, "trusted")).params,
    ).toEqual(["hidden"]);
    expect(
      render(translateOrder(users, { secret: "asc" }, "trusted")[0]).sql,
    ).toBe(`"users"."secret" asc`);
  });
});

describe("translateInclude", () => {
  it("uses private-safe defaults and bounds to-many reads", () => {
    expect(translateInclude(users, schema, { posts: true })).toEqual({
      posts: {
        columns: { id: true, authorId: true, title: true },
        limit: 50,
      },
    });
  });

  it("translates one-edge include options", () => {
    const config = translateInclude(
      users,
      schema,
      {
        posts: {
          select: ["id", "secret"],
          where: { title: { ilike: "a%" } },
          order: { id: "desc" },
          limit: 5,
        },
      },
      "trusted",
    ) as { posts: Record<string, unknown> };
    expect(config.posts.columns).toEqual({ id: true, secret: true });
    expect(config.posts.limit).toBe(5);
    expect(render(config.posts.where as SQL).params).toEqual(["a%"]);
  });

  it("applies public column access to relation options", () => {
    expect(() =>
      translateInclude(users, schema, {
        posts: { select: ["secret"] },
      }),
    ).toThrow(DatabasePluginError);
    expect(() =>
      translateInclude(users, schema, {
        posts: { where: { secret: "hidden" } },
      }),
    ).toThrow(DatabasePluginError);
    expect(() =>
      translateInclude(users, schema, {
        posts: { order: { secret: "asc" } },
      }),
    ).toThrow(DatabasePluginError);
  });

  it("rejects unknown relations and invalid relation limits", () => {
    expect(() => translateInclude(users, schema, { missing: true })).toThrow(
      DatabasePluginError,
    );
    expect(() =>
      translateInclude(users, schema, { posts: { limit: MAX_LIMIT + 1 } }),
    ).toThrow(DatabasePluginError);
    expect(() =>
      translateInclude(schema.$tables.posts, schema, { users: { limit: 1 } }),
    ).toThrow(DatabasePluginError);

    const tooMany = Object.fromEntries(
      Array.from({ length: MAX_INCLUDES + 1 }, (_, index) => [
        `relation${index}`,
        true,
      ]),
    );
    expect(() => translateInclude(users, schema, tooMany)).toThrow(
      DatabasePluginError,
    );
  });
});
