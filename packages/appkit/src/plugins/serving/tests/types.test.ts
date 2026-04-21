import { assertType, describe, expectTypeOf, test } from "vitest";
import type { ServingEndpointHandle } from "../types";

/**
 * Compile-time type tests for the serving type system.
 * These tests verify that the IsUnion utility type and the 3-way ServingFactory
 * conditional produce correct signatures for different registry shapes.
 *
 * Tests use expectTypeOf (pure type-level, no runtime calls).
 */

// Mirror IsUnion from types.ts (not exported, so re-declared here for testing)
type IsUnion<T, C = T> = T extends C ? ([C] extends [T] ? false : true) : never;

// ── IsUnion ─────────────────────────────────────────────────────────────

describe("IsUnion", () => {
  test("single literal is not a union", () => {
    assertType<false>(false as IsUnion<"a">);
  });

  test("two-member union is detected", () => {
    assertType<true>(true as IsUnion<"a" | "b">);
  });

  test("three-member union is detected", () => {
    assertType<true>(true as IsUnion<"a" | "b" | "c">);
  });
});

// ── ServingFactory-equivalent patterns ──────────────────────────────────
// We can't augment ServingEndpointRegistry differently per test, so we
// test the conditional logic using equivalent local types.

interface SingleKeyRegistry {
  default: {
    request: { prompt: string };
    response: { text: string };
  };
}

interface MultiKeyRegistry {
  llm: {
    request: { prompt: string };
    response: { text: string };
  };
  embedder: {
    request: { text: string };
    response: number[];
  };
}

// Factory type mirroring ServingFactory but parameterised by registry
type TestFactory<R> = keyof R extends never
  ? (alias?: string) => ServingEndpointHandle
  : true extends IsUnion<keyof R>
    ? <K extends keyof R>(alias: K) => ServingEndpointHandle
    : {
        <K extends keyof R>(alias: K): ServingEndpointHandle;
        (): ServingEndpointHandle;
      };

describe("ServingFactory conditional", () => {
  test("empty registry: produces function with optional string param", () => {
    type F = TestFactory<Record<string, never>>;
    expectTypeOf<F>().toBeFunction();
    // Alias is optional — should accept (alias?: string)
    expectTypeOf<F>().parameter(0).toEqualTypeOf<string | undefined>();
  });

  test("single-key registry: has call signatures including no-arg", () => {
    type F = TestFactory<SingleKeyRegistry>;
    // Should be callable (it's an object with call signatures)
    expectTypeOf<F>().toBeCallableWith("default");
    expectTypeOf<F>().toBeCallableWith();
  });

  test("multi-key registry: alias is required", () => {
    type F = TestFactory<MultiKeyRegistry>;
    expectTypeOf<F>().toBeCallableWith("llm");
    expectTypeOf<F>().toBeCallableWith("embedder");
    // No-arg call should NOT be valid — verified via @ts-expect-error
    // @ts-expect-error - calling with no args should fail for multi-key
    expectTypeOf<F>().toBeCallableWith();
  });
});
