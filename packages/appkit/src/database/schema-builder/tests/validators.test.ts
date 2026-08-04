import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import {
  type AppKitTable,
  bigint,
  boolean,
  defineSchema,
  enumColumn,
  id,
  integer,
  jsonb,
  text,
  timestamp,
  uuid,
  varchar,
} from "../index";
import { deriveInsertSchema, deriveUpdateSchema } from "../validators";

/** Read the per-field shape off a derived Zod object schema (test-only seam). */
function shapeOf(schema: ZodType): Record<string, ZodType> {
  return (schema as unknown as { shape: Record<string, ZodType> }).shape;
}

const schema = defineSchema((t) => ({
  users: t.table("users", {
    id: id(),
    email: text().notNull(),
    name: text(),
    role: enumColumn("user_role", ["admin", "member"])
      .notNull()
      .default("member"),
    loginCount: integer().notNull().default(0),
    secret: text().notNull().private(),
    createdAt: timestamp().notNull().defaultNow(),
  }),
  // Natural (non server-generated) PK: present in insert, omitted from update.
  accounts: t.table("accounts", {
    slug: text().primaryKey().notNull(),
    label: text().notNull(),
  }),
  types: t.table("types", {
    id: id(),
    tags: text().notNull(),
    short: varchar(3).notNull(),
    count: integer().notNull(),
    big: bigint().notNull(),
    flag: boolean().notNull(),
    when: timestamp().notNull(),
    doc: jsonb().notNull(),
    ref: uuid().notNull(),
    status: enumColumn("status_kind", ["open", "closed"]).notNull(),
  }),
}));

const users = schema.$tables.users;
const accounts = schema.$tables.accounts;
const types = schema.$tables.types;
const validUserInsert = { email: "a@b.com", secret: "server-only" };

describe("defineSchema — validator wiring", () => {
  it("stamps $insertSchema and $updateSchema on every table", () => {
    for (const table of Object.values(schema.$tables) as AppKitTable[]) {
      expect(table.$insertSchema).toBeDefined();
      expect(table.$updateSchema).toBeDefined();
    }
  });
});

describe("deriveInsertSchema", () => {
  const insert = deriveInsertSchema(users);

  it("includes private fields and omits only server-generated columns", () => {
    expect(Object.keys(shapeOf(insert)).sort()).toEqual([
      "createdAt",
      "email",
      "loginCount",
      "name",
      "role",
      "secret",
    ]);
  });

  it("keeps a required (notNull, no default) column required", () => {
    expect(insert.safeParse({}).success).toBe(false);
    expect(insert.safeParse({ email: "a@b.com" }).success).toBe(false);
    expect(insert.safeParse(validUserInsert).success).toBe(true);
  });

  it("rejects unknown fields instead of stripping them", () => {
    expect(
      insert.safeParse({ ...validUserInsert, unexpected: true }).success,
    ).toBe(false);
  });

  it("makes defaulted columns optional even when notNull", () => {
    const shape = shapeOf(insert);
    expect(shape.role.safeParse(undefined).success).toBe(true);
    expect(shape.loginCount.safeParse(undefined).success).toBe(true);
    expect(shape.createdAt.safeParse(undefined).success).toBe(true);
  });

  it("makes nullable columns both nullable and optional", () => {
    const name = shapeOf(insert).name;
    expect(name.safeParse(null).success).toBe(true);
    expect(name.safeParse(undefined).success).toBe(true);
    expect(name.safeParse("Ada").success).toBe(true);
  });

  it("keeps a non-server-generated PK in the insert payload", () => {
    expect(Object.keys(shapeOf(deriveInsertSchema(accounts))).sort()).toEqual([
      "label",
      "slug",
    ]);
  });
});

describe("deriveUpdateSchema", () => {
  it("includes private fields and omits primary-key and generated columns", () => {
    expect(Object.keys(shapeOf(deriveUpdateSchema(accounts)))).toEqual([
      "label",
    ]);
    expect(Object.keys(shapeOf(deriveUpdateSchema(users))).sort()).toEqual([
      "createdAt",
      "email",
      "loginCount",
      "name",
      "role",
      "secret",
    ]);
  });

  it("is fully partial — every field optional, including required ones", () => {
    const update = deriveUpdateSchema(users);
    expect(update.safeParse({}).success).toBe(true);
    expect(update.safeParse({ email: "a@b.com" }).success).toBe(true);
    // `email` is notNull/no-default (required on insert) but optional on update.
    expect(shapeOf(update).email.safeParse(undefined).success).toBe(true);
  });

  it("rejects unknown fields instead of stripping them", () => {
    expect(
      deriveUpdateSchema(users).safeParse({ unexpected: true }).success,
    ).toBe(false);
  });
});

describe("zodForColumn — engine-neutral kind mapping", () => {
  const shape = shapeOf(deriveInsertSchema(types));

  it("maps string columns to z.string()", () => {
    expect(shape.tags.safeParse("x").success).toBe(true);
    expect(shape.tags.safeParse(5).success).toBe(false);
    expect(shape.short.safeParse("abc").success).toBe(true);
    expect(shape.short.safeParse("toolong").success).toBe(false);
  });

  it("accepts only PostgreSQL int4 values for number columns", () => {
    expect(shape.count.safeParse(5).success).toBe(true);
    expect(shape.count.safeParse("5").success).toBe(false);
    expect(shape.count.safeParse(1.5).success).toBe(false);
    expect(shape.count.safeParse(2_147_483_648).success).toBe(false);
  });

  it("uses bigint as the canonical bigint runtime value", () => {
    expect(shape.big.safeParse(5n).success).toBe(true);
    expect(shape.big.safeParse(5).success).toBe(false);
    expect(shape.big.safeParse("5").success).toBe(false);
    expect(shape.big.safeParse(true).success).toBe(false);
  });

  it("maps boolean columns to z.boolean()", () => {
    expect(shape.flag.safeParse(true).success).toBe(true);
    expect(shape.flag.safeParse("true").success).toBe(false);
  });

  it("uses ISO 8601 strings as canonical timestamp values", () => {
    expect(shape.when.safeParse("2020-01-01T00:00:00Z").success).toBe(true);
    expect(shape.when.safeParse("2020-01-01T00:00:00").success).toBe(true);
    expect(shape.when.safeParse(new Date()).success).toBe(false);
    expect(shape.when.safeParse("not-a-timestamp").success).toBe(false);
    expect(shape.when.safeParse(5).success).toBe(false);
  });

  it("accepts JSON values and rejects non-JSON runtime objects", () => {
    expect(shape.doc.safeParse({ nested: [1, 2] }).success).toBe(true);
    expect(shape.doc.safeParse(new Date()).success).toBe(false);
    expect(shape.doc.safeParse({ nested: undefined }).success).toBe(false);
    expect(shape.doc.safeParse(1n).success).toBe(false);
  });

  it("accepts canonical UUID strings", () => {
    expect(
      shape.ref.safeParse("123e4567-e89b-12d3-a456-426614174000").success,
    ).toBe(true);
    expect(shape.ref.safeParse("not-a-real-uuid").success).toBe(false);
    expect(shape.ref.safeParse(123).success).toBe(false);
  });

  it("maps enum columns to z.enum() over the declared values", () => {
    expect(shape.status.safeParse("open").success).toBe(true);
    expect(shape.status.safeParse("nope").success).toBe(false);
  });
});
