import { describe, expect, it } from "vitest";

import {
  bigint,
  boolean,
  defineSchema,
  enumColumn,
  fk,
  id,
  jsonb,
  text,
  timestamp,
  uuid,
} from "../../../../database/schema-builder";
import { walkSchema } from "../../../../type-generator/database/walk-schema";
import { columnHttpCapabilities } from "../capabilities";
import { compileCrudTables } from "../contract";

const schema = defineSchema((builder) => {
  const users = builder.table("users", {
    id: id(),
    name: text().notNull(),
    token: text().private(),
    profile: jsonb(),
    total: bigint(),
  });
  const invites = builder.table("invites", {
    code: text().primaryKey(),
    email: text().notNull(),
    label: text().default("guest"),
    createdAt: timestamp().defaultNow(),
    userId: fk(() => users.id),
  });
  const sessions = builder.table("sessions", {
    id: uuid().primaryKey().defaultRandom(),
    token: uuid().defaultRandom(),
    active: boolean().notNull(),
    kind: enumColumn("session_kind", ["web", "cli"]),
  });
  const audits = builder.table("audits", {
    id: id().private(),
    action: text(),
  });
  const blobs = builder.table("blobs", { payload: jsonb() });
  return { users, invites, sessions, audits, blobs };
});

/** Property names in one rendered object facet, in declaration order. */
function facetKeys(facet: string): string[] {
  return [...facet.matchAll(/^ +"([^"]+)"\??:/gm)].map((match) => match[1]);
}

/** Members of one rendered literal union; `never` renders as none. */
function unionMembers(union: string): string[] {
  return union === "never" ? [] : union.split(" | ").map((m) => JSON.parse(m));
}

describe("columnHttpCapabilities", () => {
  it("keeps a private column out of every HTTP capability", () => {
    expect(columnHttpCapabilities(schema.$tables.users.$columns.token)).toEqual(
      {
        selectable: false,
        queryable: false,
        creatable: false,
        updatable: false,
        publicKey: false,
      },
    );
    expect(
      columnHttpCapabilities(schema.$tables.audits.$columns.id).publicKey,
    ).toBe(false);
  });

  it("separates generated identities, caller keys, and stamps", () => {
    const { users, invites, sessions } = schema.$tables;
    expect(columnHttpCapabilities(users.$columns.id)).toMatchObject({
      queryable: true,
      creatable: false,
      publicKey: true,
    });
    expect(columnHttpCapabilities(invites.$columns.code)).toMatchObject({
      creatable: true,
      updatable: false,
      publicKey: true,
    });
    expect(columnHttpCapabilities(invites.$columns.createdAt)).toMatchObject({
      creatable: true,
      updatable: false,
    });
    expect(columnHttpCapabilities(sessions.$columns.id)).toMatchObject({
      creatable: false,
      publicKey: true,
    });
    expect(columnHttpCapabilities(sessions.$columns.token)).toMatchObject({
      creatable: true,
      updatable: false,
    });
    expect(columnHttpCapabilities(users.$columns.profile)).toMatchObject({
      selectable: true,
      queryable: false,
      updatable: true,
    });
  });
});

describe("HTTP capability parity", () => {
  const compiled = compileCrudTables(schema.$tables);
  const entries = new Map(walkSchema(schema).map((e) => [e.name, e]));

  it.each(Object.keys(schema.$tables))(
    "generates the %s api facet from the sets its routes compile",
    (name) => {
      const table = compiled.get(name);
      const api = entries.get(name)?.api;
      if (!table || !api) throw new Error(`missing ${name}`);

      expect(facetKeys(api.insert)).toEqual([...table.creatable]);
      expect(facetKeys(api.update)).toEqual([...table.updatable]);
      expect(facetKeys(api.filters)).toEqual([...table.queryable]);
      expect(unionMembers(api.orderable)).toEqual([...table.queryable]);
      expect(unionMembers(api.key)).toEqual(
        table.primaryKey ? [table.primaryKey.meta.columnName] : [],
      );
    },
  );

  it("never renders a private column into an api facet", () => {
    const users = entries.get("users");
    // The trusted facets keep the private column; the HTTP ones never see it.
    expect(users?.insert).toContain('"token"');
    expect(Object.values(users?.api ?? {}).join("\n")).not.toContain('"token"');
    expect(
      Object.values(entries.get("audits")?.api ?? {}).join("\n"),
    ).not.toContain('"id"');
    expect(entries.get("audits")?.api.key).toBe("never");
    expect(entries.get("blobs")?.api.orderable).toBe("never");
  });
});
