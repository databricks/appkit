import { createTableRelationsHelpers, Many, One } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { buildEngineRelations } from "../engine/relations";
import { defineSchema, fk, id, text } from "../index";

/** Structural view of a Drizzle `relations()` object (avoids leaning on internals' exact types). */
type RelationsLike = {
  table: PgTable;
  config: (helpers: unknown) => Record<string, unknown>;
};

/** A built `one()` relation's resolved config. */
type OneInternals = {
  config?: { fields: { name: string }[]; references: { name: string }[] };
  referencedTableName: string;
};

/** Materialize the per-relation config from an emitted `relations()` object. */
function configOf(rel: unknown): Record<string, unknown> {
  const r = rel as RelationsLike;
  return r.config(createTableRelationsHelpers(r.table));
}

describe("buildEngineRelations", () => {
  const schema = defineSchema((t) => {
    const users = t.table("users", { id: id(), name: text() });
    const posts = t.table("posts", {
      id: id(),
      authorId: fk(() => users.id).notNull(),
    });
    return { users, posts };
  });
  const engineRelations = buildEngineRelations(schema.$tables);

  it("emits a <table>Relations entry per participating table", () => {
    expect(Object.keys(engineRelations).sort()).toEqual([
      "postsRelations",
      "usersRelations",
    ]);
  });

  it("emits a one() with the correct fields/references on the FK owner", () => {
    const cfg = configOf(engineRelations.postsRelations);
    expect(Object.keys(cfg)).toEqual(["users"]);

    const rel = cfg.users;
    expect(rel instanceof One).toBe(true);

    const one = rel as unknown as OneInternals;
    expect(one.config?.fields.map((c) => c.name)).toEqual(["authorId"]);
    expect(one.config?.references.map((c) => c.name)).toEqual(["id"]);
    expect(one.referencedTableName).toBe("users");
  });

  it("emits a many() on the FK target", () => {
    const cfg = configOf(engineRelations.usersRelations);
    expect(Object.keys(cfg)).toEqual(["posts"]);

    const rel = cfg.posts;
    expect(rel instanceof Many).toBe(true);
    expect(
      (rel as unknown as { referencedTableName: string }).referencedTableName,
    ).toBe("posts");
  });

  it("resolves relation targets by canonical table identity", () => {
    const s = defineSchema((t) => {
      const cases = t.table("cases", { id: id() });
      const status_history = t.table("status_history", {
        id: id(),
        caseId: fk(() => cases.id),
      });
      return { cases, status_history };
    });
    const rels = buildEngineRelations(s.$tables);

    expect(Object.keys(rels).sort()).toEqual([
      "casesRelations",
      "status_historyRelations",
    ]);
    expect(configOf(rels.casesRelations).status_history instanceof Many).toBe(
      true,
    );
    expect(configOf(rels.status_historyRelations).cases instanceof One).toBe(
      true,
    );
  });

  it("returns an empty map when no table participates in a relation", () => {
    const standalone = defineSchema((t) => ({
      widgets: t.table("widgets", { id: id(), label: text() }),
    }));
    expect(buildEngineRelations(standalone.$tables)).toEqual({});
  });
});
