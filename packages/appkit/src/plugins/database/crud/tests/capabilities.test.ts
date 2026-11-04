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
  const flags = builder.table("flags", { key: boolean().primaryKey() });
  const documents = builder.table("documents", { key: jsonb().primaryKey() });
  return { users, invites, sessions, audits, blobs, flags, documents };
});

describe("columnHttpCapabilities", () => {
  it("keeps a private column out of every HTTP capability", () => {
    expect(columnHttpCapabilities(schema.$tables.users.$columns.token)).toEqual(
      {
        selectable: false,
        creatable: false,
        updatable: false,
        publicKey: false,
      },
    );
    expect(
      columnHttpCapabilities(schema.$tables.audits.$columns.id).publicKey,
    ).toBe(false);
  });

  it.each(["flags", "documents"] as const)(
    "keeps %s available for creates but never claims its key can address a path",
    (name) => {
      const meta = schema.$tables[name].$columns.key;
      expect(meta.primaryKey).toBe(true);
      expect(columnHttpCapabilities(meta)).toMatchObject({
        selectable: true,
        creatable: true,
        updatable: false,
        publicKey: false,
      });
      expect(
        walkSchema(schema).find((entry) => entry.name === name)?.api.key,
      ).toBe("never");
    },
  );

  it("separates generated identities, caller keys, and stamps", () => {
    const { users, invites, sessions } = schema.$tables;
    expect(columnHttpCapabilities(users.$columns.id)).toMatchObject({
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
      updatable: true,
    });
  });
});

describe("generated api facets", () => {
  const entries = new Map(walkSchema(schema).map((e) => [e.name, e]));

  it("never renders a private column into an api facet", () => {
    const users = entries.get("users");
    // The trusted facets keep the private column; the HTTP ones never see it.
    expect(users?.insert).toContain('"token"');
    expect(Object.values(users?.api ?? {}).join("\n")).not.toContain('"token"');
    expect(
      Object.values(entries.get("audits")?.api ?? {}).join("\n"),
    ).not.toContain('"id"');
    expect(entries.get("audits")?.api.key).toBe("never");
  });
});
