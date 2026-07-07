import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import {
  type AppKitTable,
  bigint,
  boolean,
  defineSchema,
  deriveInsertSchema,
  deriveUpdateSchema,
  enumColumn,
  id,
  integer,
  jsonb,
  text,
  timestamp,
  uuid,
} from "../index";

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

  it("omits private and server-generated columns", () => {
    expect(Object.keys(shapeOf(insert)).sort()).toEqual([
      "createdAt",
      "email",
      "loginCount",
      "name",
      "role",
    ]);
  });

  it("keeps a required (notNull, no default) column required", () => {
    expect(insert.safeParse({}).success).toBe(false);
    expect(insert.safeParse({ email: "a@b.com" }).success).toBe(true);
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
  it("omits the primary key (and private + server-generated)", () => {
    expect(Object.keys(shapeOf(deriveUpdateSchema(accounts)))).toEqual([
      "label",
    ]);
    expect(Object.keys(shapeOf(deriveUpdateSchema(users))).sort()).toEqual([
      "createdAt",
      "email",
      "loginCount",
      "name",
      "role",
    ]);
  });

  it("is fully partial — every field optional, including required ones", () => {
    const update = deriveUpdateSchema(users);
    expect(update.safeParse({}).success).toBe(true);
    expect(update.safeParse({ email: "a@b.com" }).success).toBe(true);
    // `email` is notNull/no-default (required on insert) but optional on update.
    expect(shapeOf(update).email.safeParse(undefined).success).toBe(true);
  });
});

describe("zodForColumn — engine-neutral kind mapping", () => {
  const shape = shapeOf(deriveInsertSchema(types));

  it("maps string columns to z.string()", () => {
    expect(shape.tags.safeParse("x").success).toBe(true);
    expect(shape.tags.safeParse(5).success).toBe(false);
  });

  it("maps number columns to z.number()", () => {
    expect(shape.count.safeParse(5).success).toBe(true);
    expect(shape.count.safeParse("5").success).toBe(false);
  });

  it("maps bigint columns to a bigint | number | string union", () => {
    expect(shape.big.safeParse(5n).success).toBe(true);
    expect(shape.big.safeParse(5).success).toBe(true);
    expect(shape.big.safeParse("5").success).toBe(true);
    expect(shape.big.safeParse(true).success).toBe(false);
  });

  it("maps boolean columns to z.boolean()", () => {
    expect(shape.flag.safeParse(true).success).toBe(true);
    expect(shape.flag.safeParse("true").success).toBe(false);
  });

  it("maps date columns to a date | string union", () => {
    expect(shape.when.safeParse(new Date()).success).toBe(true);
    expect(shape.when.safeParse("2020-01-01T00:00:00Z").success).toBe(true);
    expect(shape.when.safeParse(5).success).toBe(false);
  });

  it("maps json columns to z.unknown() (accepts arbitrary values)", () => {
    expect(shape.doc.safeParse({ nested: [1, 2] }).success).toBe(true);
  });

  it("maps uuid columns to z.string() (no format constraint)", () => {
    expect(shape.ref.safeParse("not-a-real-uuid").success).toBe(true);
    expect(shape.ref.safeParse(123).success).toBe(false);
  });

  it("maps enum columns to z.enum() over the declared values", () => {
    expect(shape.status.safeParse("open").success).toBe(true);
    expect(shape.status.safeParse("nope").success).toBe(false);
  });
});
