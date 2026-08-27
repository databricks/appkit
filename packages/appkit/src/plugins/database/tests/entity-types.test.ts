import { describe, expectTypeOf, it } from "vitest";

import type * as Beta from "../../../beta";
import type {
  DatabaseExports,
  EntityResultFor,
  IncludeArgFor,
  TransactionClient,
  TypedEntityClientFor,
} from "../entity-types";

// @ts-expect-error DataPath is an internal engine contract.
type InternalDataPath = Beta.DataPath;
// @ts-expect-error DatabasePluginError is internal.
type InternalDatabaseError = Beta.DatabasePluginError;
// @ts-expect-error Pool ownership is not part of the beta API.
type InternalPool = Beta.Pool;

type TextFilter =
  | string
  | readonly string[]
  | {
      eq?: string;
      neq?: string;
      in?: readonly string[];
      like?: string;
      ilike?: string;
      is?: null;
    };
type NumberFilter =
  | number
  | readonly number[]
  | {
      eq?: number;
      neq?: number;
      in?: readonly number[];
      gt?: number;
      gte?: number;
      lt?: number;
      lte?: number;
    };
type NoteFilters = {
  body?: TextFilter;
  rank?: NumberFilter;
  and?: readonly NoteFilters[];
  or?: readonly NoteFilters[];
};

interface TestRegistry {
  notes: {
    row: { id: string; body: string; secret: string | null; rank: number };
    publicRow: { id: string; body: string; rank: number };
    insert: { body: string; secret?: string | null; rank: number };
    update: { body?: string; secret?: string | null; rank?: number };
    filters: NoteFilters;
    includes: {
      author: { to: "users"; many: false };
      comments: { to: "comments"; many: true };
    };
    hasPrimaryKey: true;
  };
  users: {
    row: { id: string; name: string; token: string };
    publicRow: { id: string; name: string };
    insert: { name: string; token: string };
    update: { name?: string; token?: string };
    filters: { name?: TextFilter };
    includes: Record<never, never>;
    hasPrimaryKey: true;
  };
  comments: {
    row: { id: string; text: string; internal: string };
    publicRow: { id: string; text: string };
    insert: { text: string; internal: string };
    update: { text?: string; internal?: string };
    filters: { text?: TextFilter };
    includes: Record<never, never>;
    hasPrimaryKey: true;
  };
  events: {
    row: { message: string };
    publicRow: { message: string };
    insert: { message: string };
    update: { message?: string };
    filters: { message?: TextFilter };
    includes: Record<never, never>;
    hasPrimaryKey: false;
  };
}

declare const notes: TypedEntityClientFor<TestRegistry, "notes">;
declare const events: TypedEntityClientFor<TestRegistry, "events">;
declare const database: DatabaseExports;
declare const tx: TransactionClient;
const typecheckOnly = (): boolean => false;

describe("typed database entity contract", () => {
  it("keeps the intended beta types public and implementation types private", () => {
    type PublicBetaTypes = [
      Beta.DatabaseExports,
      Beta.IDatabaseConfig<Beta.Schema>,
      Beta.Schema,
    ];
    expectTypeOf<PublicBetaTypes>().not.toBeNever();
    expectTypeOf<
      InternalDataPath | InternalDatabaseError | InternalPool
    >().not.toBeNever();
  });

  it("composes keyed and keyless entity capabilities", () => {
    expectTypeOf<TypedEntityClientFor<TestRegistry, "notes">>().toHaveProperty(
      "find",
    );
    expectTypeOf<TypedEntityClientFor<TestRegistry, "notes">>().toHaveProperty(
      "update",
    );
    expectTypeOf<TypedEntityClientFor<TestRegistry, "notes">>().toHaveProperty(
      "delete",
    );
    expectTypeOf<keyof typeof events>().not.toEqualTypeOf<"find">();
    if (typecheckOnly()) {
      events.where({ message: "created" }).order({ message: "asc" });
      events.select(["message"]).include({}).limit(10).offset(2);
      void events.toArray();
      void events.first();
      void events.count();
      void events.create({ message: "created" });
      expectTypeOf(events).toHaveProperty("upsert");
      void events.upsert({ message: "created" }, { onConflict: "message" });
    }
  });

  it("defaults to public rows and narrows explicit root selections", () => {
    expectTypeOf<Awaited<ReturnType<typeof notes.first>>>().toMatchTypeOf<
      TestRegistry["notes"]["publicRow"] | null
    >();
    if (typecheckOnly()) {
      const selected = notes.select(["body", "secret"] as const);
      expectTypeOf<Awaited<ReturnType<typeof selected.first>>>().toMatchTypeOf<{
        body: string;
        secret: string | null;
      } | null>();
    }
  });

  it("keeps implicit relation projections public and narrows explicit selects", () => {
    type PublicAuthor = EntityResultFor<
      TestRegistry,
      "notes",
      TestRegistry["notes"]["publicRow"],
      { author: true }
    >;
    type FilteredAuthor = EntityResultFor<
      TestRegistry,
      "notes",
      TestRegistry["notes"]["publicRow"],
      { author: { where: { name: string }; order: { name: "asc" } } }
    >;
    type LimitedComments = EntityResultFor<
      TestRegistry,
      "notes",
      TestRegistry["notes"]["publicRow"],
      { comments: { limit: 2 } }
    >;
    type PrivateAuthor = EntityResultFor<
      TestRegistry,
      "notes",
      TestRegistry["notes"]["publicRow"],
      { author: { select: readonly ["token"] } }
    >;

    expectTypeOf<NonNullable<PublicAuthor["author"]>>().toEqualTypeOf<
      TestRegistry["users"]["publicRow"]
    >();
    expectTypeOf<NonNullable<FilteredAuthor["author"]>>().toEqualTypeOf<
      TestRegistry["users"]["publicRow"]
    >();
    expectTypeOf<LimitedComments["comments"]>().toEqualTypeOf<
      TestRegistry["comments"]["publicRow"][]
    >();
    expectTypeOf<NonNullable<PrivateAuthor["author"]>>().toEqualTypeOf<{
      token: string;
    }>();
  });

  it("omits false relations and replaces successive include configurations", () => {
    if (typecheckOnly()) {
      const included = notes
        .include({ author: { select: ["token"] } })
        .include({ comments: true })
        .include({ author: false });
      type Result = Awaited<ReturnType<typeof included.first>>;
      expectTypeOf<NonNullable<Result>>().not.toHaveProperty("author");
      expectTypeOf<NonNullable<Result>>().toHaveProperty("comments");
    }
  });

  it("accepts the supported filter and include grammar", () => {
    if (typecheckOnly()) {
      notes.where({ body: "a", rank: [1, 2] });
      notes.where({ body: { ilike: "%a%", is: null }, rank: { gte: 1 } });
      notes.where({
        and: [{ body: { in: ["a"] } }],
        or: [{ rank: { lt: 10 } }],
      });
      notes.include({
        author: { where: { name: "Ada" }, order: { name: "asc" } },
      });
      notes.include({ comments: { limit: 5 } });

      // @ts-expect-error direct null is not a filter shorthand
      notes.where({ body: null });
      // @ts-expect-error text filters do not support range operators
      notes.where({ body: { gt: "a" } });
      // @ts-expect-error number filters do not support pattern operators
      notes.where({ rank: { like: "1" } });
      // @ts-expect-error JSON and unknown fields are not filterable
      notes.where({ payload: { eq: {} } });
      // @ts-expect-error unknown relations fail closed
      notes.include({ unknown: true });
      // @ts-expect-error unknown relation options fail closed
      notes.include({ author: { offset: 1 } });
      // @ts-expect-error to-one includes cannot be limited
      notes.include({ author: { limit: 1 } });
      // @ts-expect-error nested includes are not part of one-edge options
      notes.include({ comments: { include: { author: true } } });
    }
  });

  it("restricts upsert targets to declared columns", () => {
    if (typecheckOnly()) {
      void notes.upsert({ body: "created", rank: 1 }, { onConflict: "id" });
      void notes.upsert({ body: "created", rank: 1 }, { onConflict: "body" });
      void notes.upsert(
        { body: "created", rank: 1 },
        // @ts-expect-error unknown columns cannot be conflict targets
        { onConflict: "missing" },
      );
    }
  });

  it("does not expose deferred or unsafe APIs", () => {
    if (typecheckOnly()) {
      // @ts-expect-error raw pool access is intentionally absent
      database.getPool();
      // @ts-expect-error entity reads are always bounded
      notes.unbounded();
      // @ts-expect-error transaction clients cannot open nested transactions
      tx.transaction(async () => undefined);
    }
  });

  it("keeps relationless include keys empty", () => {
    expectTypeOf<keyof IncludeArgFor<TestRegistry, "events">>().toBeNever();
  });
});
