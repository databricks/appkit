import { describe, expect, test } from "vitest";

import type { TransactionClient } from "../entity-types";
import { createMutationScope, MAX_MUTATIONS_PER_TRANSACTION } from "../scope";

const surface = (marker: string) =>
  ({ marker }) as unknown as TransactionClient;

const markerOf = (transaction: TransactionClient | undefined) =>
  (transaction as unknown as { marker: string } | undefined)?.marker;

describe("createMutationScope", () => {
  test("publishes a transaction only inside its own callback", async () => {
    const scope = createMutationScope();
    const tx = surface("one");
    expect(scope.activeTransaction()).toBeUndefined();
    await scope.runWithTransaction(tx, async () => {
      expect(scope.activeTransaction()).toBe(tx);
    });
    expect(scope.activeTransaction()).toBeUndefined();
  });

  test("keeps concurrent async trees and separate instances apart", async () => {
    const scope = createMutationScope();
    const other = createMutationScope();
    const observe = (name: string) =>
      scope.runWithTransaction(surface(name), async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(other.activeTransaction()).toBeUndefined();
        return markerOf(scope.activeTransaction());
      });

    await expect(
      Promise.all([observe("one"), observe("two")]),
    ).resolves.toEqual(["one", "two"]);
  });

  test("refuses a repeated entity and operation pair", async () => {
    const scope = createMutationScope();
    await expect(
      scope.runMutation("notes", "create", () =>
        scope.runMutation("notes", "create", async () => "unreachable"),
      ),
    ).rejects.toMatchObject({ category: "INTERNAL", phase: "write" });

    await expect(
      scope.runMutation("notes", "create", () =>
        scope.runMutation("notes", "update", async () => "reached"),
      ),
    ).resolves.toBe("reached");
  });

  test("bounds sibling mutations across one transaction", async () => {
    const scope = createMutationScope();
    const tx = surface("bounded");
    await expect(
      scope.runWithTransaction(tx, async () => {
        for (let index = 0; index < MAX_MUTATIONS_PER_TRANSACTION; index++) {
          await scope.runMutation(`table${index}`, "create", async () => index);
        }
        return scope.runMutation("overflow", "create", async () => -1);
      }),
    ).rejects.toMatchObject({ category: "INTERNAL", phase: "write" });

    await expect(
      scope.runWithTransaction(tx, () =>
        scope.runMutation("fresh", "create", async () => "reached"),
      ),
    ).resolves.toBe("reached");
  });

  test("stops runaway nesting at a fixed depth", async () => {
    const scope = createMutationScope();
    // A distinct entity per level keeps the cycle guard out of the way.
    const nest = (level: number): Promise<number> =>
      level === 0
        ? Promise.resolve(0)
        : scope.runMutation(`table${level}`, "create", () => nest(level - 1));

    await expect(nest(4)).resolves.toBe(0);
    await expect(nest(20)).rejects.toMatchObject({ category: "INTERNAL" });
  });
});
