import { describe, expect, expectTypeOf, test, vi } from "vitest";
import { z } from "zod";

import type * as Beta from "../../../beta";
import { validateOperationMetadata } from "../operation-metadata";
import {
  defineOperation,
  definePolicy,
  isOperationCandidate,
  type OperationContext,
  type PolicyContext,
} from "../operations";

// @ts-expect-error candidate detection is internal to the future loader.
type InternalCandidate = typeof Beta.isOperationCandidate;
// @ts-expect-error operations run only through the future HTTP runtime.
type InternalRunner = typeof Beta.runOperation;

// The package has no generated registry, so these calls take the untyped JS path.
const defineUntyped = defineOperation as unknown as (
  definition: Record<string, unknown>,
) => unknown;

/** A schema that fails the test if definition reads anything from it. */
function opaqueSchema(): z.ZodType {
  return new Proxy(z.object({}), {
    get(target, key) {
      if (key === "then") return undefined;
      throw new Error(`definition read schema.${String(key)}`);
    },
  });
}

const context = {
  actor: { id: "ada" },
  input: { id: 1 },
  resource: { id: 1, owner: "ada" },
} as unknown as OperationContext<{ id: number }, { id: number; owner: string }>;

describe("defineOperation", () => {
  test("freezes a descriptor that keeps every callback and schema by identity", () => {
    const input = z.object({ id: z.number() });
    const output = z.object({ id: z.number() });
    const authorize = vi.fn(() => true);
    const execute = vi.fn(() => null);

    const operation = defineUntyped({
      name: "posts.get",
      entity: "posts",
      method: "GET",
      input,
      output,
      authorize,
      execute,
    });

    expect(Object.isFrozen(operation)).toBe(true);
    expect(Object.keys(operation as object)).toEqual([
      "name",
      "entity",
      "method",
      "input",
      "output",
      "authorize",
      "execute",
    ]);
    expect(operation).toMatchObject({
      name: "posts.get",
      entity: "posts",
      method: "GET",
    });
    expect(
      Object.getOwnPropertyDescriptor(
        operation,
        Symbol.for("@databricks/appkit/database/operation"),
      )?.enumerable,
    ).toBe(false);
    const fields = operation as Record<string, unknown>;
    expect(fields.input).toBe(input);
    expect(fields.output).toBe(output);
    expect(fields.authorize).toBe(authorize);
    expect(fields.execute).toBe(execute);
    expect("~types" in (operation as object)).toBe(false);
  });

  test("runs no callback and reads no schema at definition", () => {
    const authorize = vi.fn(() => true);
    const execute = vi.fn(() => null);

    defineUntyped({
      name: "posts.create",
      entity: "posts",
      method: "POST",
      input: opaqueSchema(),
      output: opaqueSchema(),
      authorize,
      execute,
    });

    expect(authorize).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  test("keeps an untyped definition without authorize as a raw candidate", () => {
    const execute = () => null;

    const candidate = defineUntyped({
      name: "posts.get",
      entity: "posts",
      method: "GET",
      execute,
    });

    expect(isOperationCandidate(candidate)).toBe(true);
    expect(candidate).toMatchObject({ authorize: undefined, execute });
    expect(Object.isFrozen(candidate)).toBe(true);
    if (isOperationCandidate(candidate)) {
      expectTypeOf(candidate.authorize).toBeUnknown();
      expectTypeOf(candidate.execute).toBeUnknown();
    }
  });

  test("recognizes only descriptors it produced", () => {
    const fields = {
      name: "posts.get",
      entity: "posts",
      method: "GET",
      authorize: () => true,
      execute: () => null,
    };

    const operation = defineUntyped(fields);

    expect(isOperationCandidate(operation)).toBe(true);
    expect(isOperationCandidate(fields)).toBe(false);
    expect(isOperationCandidate({ ...(operation as object) })).toBe(false);
    expect(isOperationCandidate(null)).toBe(false);
    expect(isOperationCandidate(() => null)).toBe(false);
  });
});

describe("definePolicy", () => {
  test("freezes an allow-only policy that stays directly callable", () => {
    const allow = vi.fn(({ actor }: PolicyContext) => actor.id === "ada");

    const policy = definePolicy({ allow });

    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.keys(policy)).toEqual(["allow"]);
    expect(policy.allow).toBe(allow);
    expect(allow).not.toHaveBeenCalled();
    expect(policy.allow({ ...context, resource: undefined })).toBe(true);
  });

  test("keeps a resource lookup and its allow rule without running either", async () => {
    const resource = vi.fn(
      async ({ input }: PolicyContext<{ id: number }>) => ({
        id: input.id,
        owner: "ada",
      }),
    );
    const allow = vi.fn(
      ({
        actor,
        resource: post,
      }: OperationContext<{ id: number }, { owner: string }>) =>
        post.owner === actor.id,
    );

    const policy = definePolicy({ resource, allow });

    expect(Object.isFrozen(policy)).toBe(true);
    expect(policy.resource).toBe(resource);
    expect(policy.allow).toBe(allow);
    expect(resource).not.toHaveBeenCalled();
    expect(allow).not.toHaveBeenCalled();
    await expect(policy.resource(context)).resolves.toEqual({
      id: 1,
      owner: "ada",
    });
    expect(policy.allow(context)).toBe(true);
  });

  test("returns an explicit denial unchanged and does not decide at definition", () => {
    const allow = vi.fn(() => ({
      deny: "not-found" as const,
      reason: "hidden",
    }));

    const policy = definePolicy({ allow });

    expect(allow).not.toHaveBeenCalled();
    expect(policy.allow({ ...context, resource: undefined })).toEqual({
      deny: "not-found",
      reason: "hidden",
    });
  });
});

describe("validateOperationMetadata", () => {
  const entities = new Set(["posts"]);
  const located = (exportName: string, value: unknown) => ({
    file: "routes/posts.ts",
    exportName,
    value,
  });

  test("accepts a named operation and ignores an ordinary export", () => {
    const authorize = () => true;
    const execute = () => null;
    const input = z.object({ id: z.number() });
    const operation = defineUntyped({
      name: "posts.get",
      entity: "posts",
      method: "GET",
      input,
      authorize,
      execute,
    });

    const result = validateOperationMetadata(
      [located("helper", { name: "posts.get" }), located("getPost", operation)],
      entities,
    );

    expect(result.skipped).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.operations).toEqual([
      {
        file: "routes/posts.ts",
        exportName: "getPost",
        name: "posts.get",
        entity: "posts",
        method: "GET",
        input,
        output: undefined,
        authorize,
        execute,
      },
    ]);
  });

  test("skips a declaration whose only problem is missing authorization", () => {
    const unauthorized = defineUntyped({
      name: "posts.get",
      entity: "posts",
      method: "GET",
      execute: () => null,
    });

    const result = validateOperationMetadata(
      [located("unauthorized", unauthorized)],
      entities,
    );

    expect(result.operations).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.skipped).toMatchObject([
      {
        file: "routes/posts.ts",
        exportName: "unauthorized",
        code: "authorize",
      },
    ]);
    expect(result.skipped[0]?.message).toContain("skipped");
  });

  test("reports every malformed field, with or without authorization", () => {
    const unauthorized = defineUntyped({
      name: "posts.get.",
      entity: "missing",
      method: "HEAD",
      execute: () => null,
    });
    const malformed = defineUntyped({
      // Four valid 64-character parts exceed the total length.
      name: Array.from({ length: 4 }, () => "x".repeat(64)).join("."),
      entity: "missing",
      method: "HEAD",
      input: {},
      output: "row",
      authorize: { allow: true },
      execute: null,
    });

    const result = validateOperationMetadata(
      [located("unauthorized", unauthorized), located("malformed", malformed)],
      entities,
    );

    expect(result.operations).toEqual([]);
    expect(result.skipped.map((entry) => entry.exportName)).toEqual([
      "unauthorized",
    ]);
    expect(
      result.errors.map((entry) => `${entry.exportName} ${entry.code}`),
    ).toEqual([
      "unauthorized name",
      "unauthorized entity",
      "unauthorized method",
      "malformed name",
      "malformed entity",
      "malformed method",
      "malformed input",
      "malformed output",
      "malformed execute",
      "malformed authorize",
    ]);
  });

  test("reserves names a plain object cannot hold as its own key", () => {
    const reserved = ["constructor", "prototype"].map((name) =>
      located(
        name,
        defineUntyped({
          name,
          entity: "posts",
          method: "GET",
          authorize: () => true,
          execute: () => null,
        }),
      ),
    );

    const result = validateOperationMetadata(reserved, entities);

    expect(result.operations).toEqual([]);
    expect(result.errors.map((entry) => entry.message)).toEqual([
      'routes/posts.ts#constructor cannot use the reserved operation name "constructor".',
      'routes/posts.ts#prototype cannot use the reserved operation name "prototype".',
    ]);
  });

  test("rejects a repeated operation name without dropping the first", () => {
    const first = defineUntyped({
      name: "posts.get",
      entity: "posts",
      method: "GET",
      authorize: () => true,
      execute: () => null,
    });
    const second = defineUntyped({
      name: "posts.get",
      entity: "posts",
      method: "GET",
      authorize: () => true,
      execute: () => null,
    });

    const result = validateOperationMetadata(
      [located("first", first), located("second", second)],
      entities,
    );

    expect(result.operations.map((entry) => entry.exportName)).toEqual([
      "first",
    ]);
    expect(result.errors).toMatchObject([
      { exportName: "second", code: "duplicate" },
    ]);
    expect(result.errors[0]?.message).toContain("first");
  });

  test("counts a skipped declaration's name toward duplicates", () => {
    const unauthorized = defineUntyped({
      name: "posts.get",
      entity: "posts",
      method: "GET",
      execute: () => null,
    });
    const authorized = defineUntyped({
      name: "posts.get",
      entity: "posts",
      method: "GET",
      authorize: () => true,
      execute: () => null,
    });

    const result = validateOperationMetadata(
      [
        located("unauthorized", unauthorized),
        located("authorized", authorized),
      ],
      entities,
    );

    expect(result.operations).toEqual([]);
    expect(result.skipped.map((entry) => entry.exportName)).toEqual([
      "unauthorized",
    ]);
    expect(result.errors).toMatchObject([
      { exportName: "authorized", code: "duplicate" },
    ]);
  });
});

test("publishes the factories on the beta entry without internal detection", async () => {
  const beta = await import("../../../beta");

  expect(beta.defineOperation).toBe(defineOperation);
  expect(beta.definePolicy).toBe(definePolicy);
  expect(beta).not.toHaveProperty("isOperationCandidate");
  expect(beta).not.toHaveProperty("runOperation");
  expectTypeOf<InternalCandidate | InternalRunner>().not.toBeNever();
}, 30_000);
