import { describe, expectTypeOf, it } from "vitest";

import type { DatabaseRegistryEntry, RegisteredEntity } from "../index";

/**
 * Type-level tests for the contract. These are verified by `tsc` during
 * `pnpm typecheck` (vitest typecheck is not enabled in this repo); the runtime
 * `it()` wrappers exist only so vitest registers the file as a suite.
 *
 * `DatabaseRegistry` is a global declaration-merging target, so we can't augment
 * it per-test without polluting the whole project's typecheck. Instead we mirror
 * the `RegisteredEntity` mapped-type logic over a local interface to prove the
 * empty -> `never` and augmented -> literal-keys behaviour (same approach as
 * plugins/serving/tests/types.test.ts).
 */

// Mirror of RegisteredEntity from registry.ts, parameterised by an arbitrary
// registry interface so we can test both the empty and augmented states.
type RegisteredEntityOf<R> = keyof {
  [K in keyof R as string extends K ? never : K]: true;
};

describe("RegisteredEntity (declaration-merging behaviour)", () => {
  it("resolves to never on the empty base registry", () => {
    expectTypeOf<RegisteredEntityOf<Record<never, never>>>().toBeNever();
    // The real, un-augmented contract type is also never until typegen runs.
    expectTypeOf<RegisteredEntity>().toBeNever();
  });

  it("resolves to the literal keys once the registry is augmented", () => {
    interface AugmentedRegistry {
      users: DatabaseRegistryEntry;
      posts: DatabaseRegistryEntry;
    }
    expectTypeOf<RegisteredEntityOf<AugmentedRegistry>>().toEqualTypeOf<
      "users" | "posts"
    >();
  });

  it("ignores a string index signature (stays never)", () => {
    expectTypeOf<
      RegisteredEntityOf<Record<string, DatabaseRegistryEntry>>
    >().toBeNever();
  });
});

describe("DatabaseRegistryEntry shape", () => {
  it("exposes the five generated facets as records", () => {
    expectTypeOf<DatabaseRegistryEntry>().toHaveProperty("row");
    expectTypeOf<DatabaseRegistryEntry>().toHaveProperty("insert");
    expectTypeOf<DatabaseRegistryEntry>().toHaveProperty("update");
    expectTypeOf<DatabaseRegistryEntry>().toHaveProperty("filters");
    expectTypeOf<DatabaseRegistryEntry>().toHaveProperty("includes");
  });
});
