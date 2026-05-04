import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, test } from "vitest";
import {
  defineSchema,
  id,
  integer,
  text,
  timestamp,
} from "../../schema-builder";
import { buildOrder, buildWhere } from "../drizzle-runtime";

const schema = defineSchema(({ table }) => ({
  user: table("user", {
    id: id(),
    email: text().notNull(),
    role: text(),
    age: integer(),
    createdAt: timestamp(),
  }),
}));

const dialect = new PgDialect();

describe("drizzle-runtime buildWhere → SQL", () => {
  test("scalar shorthand becomes col = $1", () => {
    const sql = buildWhere(schema.user, { email: "alice@x" });
    expect(sql).toBeDefined();
    if (sql) {
      const out = dialect.sqlToQuery(sql);
      expect(out.sql).toMatch(/"email" = \$1/);
      expect(out.params).toEqual(["alice@x"]);
    }
  });

  test("array value becomes col IN ($1, $2)", () => {
    const sql = buildWhere(schema.user, { role: ["admin", "owner"] });
    if (sql) {
      const out = dialect.sqlToQuery(sql);
      expect(out.sql).toMatch(/"role" in \(\$1, \$2\)/);
      expect(out.params).toEqual(["admin", "owner"]);
    }
  });

  test("operator object renders gte / lte / ilike / is null", () => {
    const sql = buildWhere(schema.user, {
      age: { gte: 18, lte: 65 },
      email: { ilike: "%@example.com" },
      role: { is: null },
    });
    expect(sql).toBeDefined();
    if (sql) {
      const out = dialect.sqlToQuery(sql);
      expect(out.sql).toContain('"age" >= ');
      expect(out.sql).toContain('"age" <= ');
      expect(out.sql).toContain('"email" ilike ');
      expect(out.sql).toContain('"role" is null');
      expect(out.params).toEqual([18, 65, "%@example.com"]);
    }
  });

  test("undefined spec returns undefined (no WHERE clause)", () => {
    expect(buildWhere(schema.user, undefined)).toBeUndefined();
  });

  test("empty spec returns undefined (no WHERE clause)", () => {
    expect(buildWhere(schema.user, {})).toBeUndefined();
  });
});

describe("drizzle-runtime buildOrder → SQL", () => {
  test("returns empty list for missing or empty spec", () => {
    expect(buildOrder(schema.user, undefined)).toEqual([]);
    expect(buildOrder(schema.user, {})).toEqual([]);
  });

  test("preserves the declared order of clauses", () => {
    const out = buildOrder(schema.user, { email: "asc", createdAt: "desc" });
    expect(out).toHaveLength(2);
    const first = dialect.sqlToQuery(out[0]);
    expect(first.sql).toContain('"email"');
    expect(first.sql.toLowerCase()).toContain("asc");
    const second = dialect.sqlToQuery(out[1]);
    expect(second.sql).toContain('"createdAt"');
    expect(second.sql.toLowerCase()).toContain("desc");
  });
});
