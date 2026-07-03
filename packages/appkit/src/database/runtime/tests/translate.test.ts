import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { IN_CAP, MAX_INCLUDES, MAX_LIMIT } from "../../contract";
import {
  boolean,
  defineSchema,
  fk,
  id,
  integer,
  text,
} from "../../schema-builder";
import { DataPathError } from "../data-path";
import {
  selectToColumns,
  translateInclude,
  translateOrder,
  translateWhere,
} from "../index";

const schema = defineSchema((t) => {
  const users = t.table("users", {
    id: id(),
    name: text(),
    age: integer(),
    active: boolean(),
  });
  const posts = t.table("posts", {
    id: id(),
    title: text(),
    secret: text().private(),
    authorId: fk(() => users.id).notNull(),
  });
  return { users, posts };
});

const tables = schema.$tables;
const users = tables.users;

const dialect = new PgDialect();

function render(frag: SQL | undefined): { sql: string; params: unknown[] } {
  if (!frag) throw new Error("expected an SQL fragment, got undefined");
  const { sql, params } = dialect.sqlToQuery(frag);
  return { sql, params: params as unknown[] };
}

describe("translateWhere — operators", () => {
  it("scalar shorthand becomes eq", () => {
    const { sql, params } = render(
      translateWhere(users, tables, { name: "bob" }),
    );
    expect(sql).toBe(`"users"."name" = $1`);
    expect(params).toEqual(["bob"]);
  });

  it("eq operator object", () => {
    const { sql, params } = render(
      translateWhere(users, tables, { name: { eq: "bob" } }),
    );
    expect(sql).toBe(`"users"."name" = $1`);
    expect(params).toEqual(["bob"]);
  });

  it("eq null becomes IS NULL", () => {
    const { sql, params } = render(
      translateWhere(users, tables, { name: { eq: null } }),
    );
    expect(sql).toBe(`"users"."name" is null`);
    expect(params).toEqual([]);
  });

  it("scalar null shorthand becomes IS NULL", () => {
    const { sql } = render(translateWhere(users, tables, { name: null }));
    expect(sql).toBe(`"users"."name" is null`);
  });

  it("neq becomes <>", () => {
    const { sql } = render(translateWhere(users, tables, { age: { neq: 5 } }));
    expect(sql).toBe(`"users"."age" <> $1`);
  });

  it("neq null becomes IS NOT NULL", () => {
    const { sql } = render(
      translateWhere(users, tables, { name: { neq: null } }),
    );
    expect(sql).toBe(`"users"."name" is not null`);
  });

  it("gt / gte / lt / lte", () => {
    expect(render(translateWhere(users, tables, { age: { gt: 1 } })).sql).toBe(
      `"users"."age" > $1`,
    );
    expect(render(translateWhere(users, tables, { age: { gte: 1 } })).sql).toBe(
      `"users"."age" >= $1`,
    );
    expect(render(translateWhere(users, tables, { age: { lt: 1 } })).sql).toBe(
      `"users"."age" < $1`,
    );
    expect(render(translateWhere(users, tables, { age: { lte: 1 } })).sql).toBe(
      `"users"."age" <= $1`,
    );
  });

  it("like / ilike coerce to string", () => {
    expect(
      render(translateWhere(users, tables, { name: { like: "a%" } })).sql,
    ).toBe(`"users"."name" like $1`);
    expect(
      render(translateWhere(users, tables, { name: { ilike: "a%" } })).sql,
    ).toBe(`"users"."name" ilike $1`);
  });

  it("in produces a parameterized list", () => {
    const { sql, params } = render(
      translateWhere(users, tables, { id: { in: [1, 2, 3] } }),
    );
    expect(sql).toBe(`"users"."id" in ($1, $2, $3)`);
    expect(params).toEqual([1, 2, 3]);
  });

  it("array shorthand becomes an IN filter", () => {
    const { sql, params } = render(
      translateWhere(users, tables, { id: [1, 2, 3] }),
    );
    expect(sql).toBe(`"users"."id" in ($1, $2, $3)`);
    expect(params).toEqual([1, 2, 3]);
  });

  it("in over IN_CAP throws", () => {
    const list = Array.from({ length: IN_CAP + 1 }, (_, i) => i);
    expect(() => translateWhere(users, tables, { id: { in: list } })).toThrow(
      DataPathError,
    );
    expect(() => translateWhere(users, tables, { id: { in: list } })).toThrow(
      /IN_CAP/,
    );
  });

  it("is null vs is not null", () => {
    expect(
      render(translateWhere(users, tables, { name: { is: null } })).sql,
    ).toBe(`"users"."name" is null`);
    expect(
      render(translateWhere(users, tables, { name: { is: "null" } })).sql,
    ).toBe(`"users"."name" is null`);
    expect(
      render(translateWhere(users, tables, { name: { is: "x" } })).sql,
    ).toBe(`"users"."name" is not null`);
  });

  it("unknown operator throws", () => {
    expect(() =>
      translateWhere(users, tables, {
        age: { foo: 1 } as Record<string, number>,
      }),
    ).toThrow(/Unknown filter operator/);
  });

  it("unknown column throws", () => {
    expect(() => translateWhere(users, tables, { nope: 1 })).toThrow(
      /Unknown column/,
    );
  });

  it("empty clause returns undefined", () => {
    expect(translateWhere(users, tables, {})).toBeUndefined();
  });
});

describe("translateWhere — and / or groups", () => {
  it("AND group joins conditions with and", () => {
    const { sql, params } = render(
      translateWhere(users, tables, {
        and: [{ age: { gt: 5 } }, { age: { lt: 10 } }],
      }),
    );
    expect(sql).toBe(`("users"."age" > $1 and "users"."age" < $2)`);
    expect(params).toEqual([5, 10]);
  });

  it("OR group joins conditions with or", () => {
    const { sql } = render(
      translateWhere(users, tables, {
        or: [{ name: "a" }, { name: "b" }],
      }),
    );
    expect(sql).toBe(`("users"."name" = $1 or "users"."name" = $2)`);
  });

  it("nested and within or", () => {
    const { sql } = render(
      translateWhere(users, tables, {
        or: [{ and: [{ age: { gt: 1 } }, { age: { lt: 9 } }] }, { name: "x" }],
      }),
    );
    expect(sql).toContain(" or ");
    expect(sql).toContain(" and ");
  });

  it("empty group contributes nothing", () => {
    expect(translateWhere(users, tables, { and: [] })).toBeUndefined();
  });

  it("a top-level group does not fall through to column lookup", () => {
    expect(() =>
      translateWhere(users, tables, { and: [{ name: "a" }] }),
    ).not.toThrow();
  });
});

describe("translateWhere — relation predicates", () => {
  it("{ some } becomes a correlated EXISTS", () => {
    const { sql } = render(
      translateWhere(users, tables, { posts: { some: { title: "x" } } }),
    );
    expect(sql).toContain("exists (");
    expect(sql).toContain(`select 1 from "posts"`);
    expect(sql).toContain(`"posts"."authorId" = "users"."id"`);
    expect(sql).toContain(`"posts"."title" = $1`);
  });

  it("{ none } becomes a correlated NOT EXISTS", () => {
    const { sql } = render(
      translateWhere(users, tables, { posts: { none: {} } }),
    );
    expect(sql).toContain("not exists (");
    expect(sql).toContain(`"posts"."authorId" = "users"."id"`);
  });

  it("unknown relation throws", () => {
    expect(() =>
      translateWhere(users, tables, { comments: { some: {} } }),
    ).toThrow(/Unknown relation/);
  });
});

describe("translateOrder", () => {
  it("asc / desc per column", () => {
    const [first, second] = translateOrder(users, {
      age: "asc",
      name: "desc",
    });
    expect(render(first).sql).toBe(`"users"."age" asc`);
    expect(render(second).sql).toBe(`"users"."name" desc`);
  });

  it("unknown column throws", () => {
    expect(() => translateOrder(users, { nope: "asc" })).toThrow(
      /Unknown column/,
    );
  });
});

describe("selectToColumns", () => {
  it("maps a select list to a columns record", () => {
    expect(selectToColumns(users, ["id", "name"])).toEqual({
      id: true,
      name: true,
    });
  });

  it("rejects unknown columns", () => {
    expect(() => selectToColumns(users, ["nope"])).toThrow(/Unknown column/);
  });
});

describe("translateInclude", () => {
  it("true includes the relation with the default child projection", () => {
    expect(translateInclude(users, tables, { posts: true })).toEqual({
      posts: {
        columns: {
          id: true,
          title: true,
          authorId: true,
        },
      },
    });
  });

  it("false skips the relation", () => {
    expect(translateInclude(users, tables, { posts: false })).toEqual({});
  });

  it("options map to a Drizzle with-config", () => {
    const cfg = translateInclude(users, tables, {
      posts: {
        select: ["title"],
        where: { title: "x" },
        order: { title: "asc" },
        limit: 5,
      },
    }) as { posts: Record<string, unknown> };

    expect(cfg.posts.columns).toEqual({ title: true });
    expect(cfg.posts.limit).toBe(5);
    expect(render(cfg.posts.where as SQL).sql).toBe(`"posts"."title" = $1`);
    const orderBy = cfg.posts.orderBy as SQL[];
    expect(orderBy).toHaveLength(1);
    expect(render(orderBy[0]).sql).toBe(`"posts"."title" asc`);
  });

  it("options without an explicit select use the default child projection", () => {
    const cfg = translateInclude(users, tables, {
      posts: {
        limit: 5,
      },
    }) as { posts: Record<string, unknown> };

    expect(cfg.posts.columns).toEqual({
      id: true,
      title: true,
      authorId: true,
    });
  });

  it("caps relation limits at MAX_LIMIT", () => {
    const cfg = translateInclude(users, tables, {
      posts: {
        limit: MAX_LIMIT + 1,
      },
    }) as { posts: Record<string, unknown> };

    expect(cfg.posts.limit).toBe(MAX_LIMIT);
  });

  it("resolves relation target tables by physical table name", () => {
    const aliased = defineSchema((t) => {
      const aliasedUsers = t.table("app_users", { id: id() });
      const aliasedPosts = t.table("app_posts", {
        id: id(),
        authorId: fk(() => aliasedUsers.id),
      });
      return { users: aliasedUsers, posts: aliasedPosts };
    });

    expect(
      translateInclude(aliased.$tables.users, aliased.$tables, {
        app_posts: true,
      }),
    ).toEqual({
      app_posts: {
        columns: {
          id: true,
          authorId: true,
        },
      },
    });
  });

  it("unknown relation throws", () => {
    expect(() => translateInclude(users, tables, { nope: true })).toThrow(
      /Unknown relation/,
    );
  });

  it("over MAX_INCLUDES throws", () => {
    const include = Object.fromEntries(
      Array.from({ length: MAX_INCLUDES + 1 }, (_, i) => [`r${i}`, true]),
    );
    expect(() => translateInclude(users, tables, include)).toThrow(
      /MAX_INCLUDES/,
    );
  });
});
