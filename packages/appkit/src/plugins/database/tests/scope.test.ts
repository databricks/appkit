import { describe, expect, test } from "vitest";

import type { TransactionClient } from "../entity-types";
import { createTransactionScope, MAX_TRANSACTION_OPERATIONS } from "../scope";

const surface = (marker: string) =>
  ({ marker }) as unknown as TransactionClient;

const markerOf = (transaction: TransactionClient | undefined) =>
  (transaction as unknown as { marker: string } | undefined)?.marker;

describe("createTransactionScope", () => {
  test("publishes a transaction only inside its own callback", async () => {
    const scope = createTransactionScope();
    const tx = surface("one");
    expect(scope.activeTransaction()).toBeUndefined();
    await scope.runWithTransaction(tx, async () => {
      expect(scope.activeTransaction()).toBe(tx);
    });
    expect(scope.activeTransaction()).toBeUndefined();
  });

  test("keeps concurrent async trees and separate instances apart", async () => {
    const scope = createTransactionScope();
    const other = createTransactionScope();
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

  test("charges only the active transaction and shares one budget", async () => {
    const scope = createTransactionScope();
    const tx = surface("bounded");
    expect(() => scope.consumeTransactionOperation()).not.toThrow();

    await expect(
      scope.runWithTransaction(tx, async () => {
        for (let index = 0; index < MAX_TRANSACTION_OPERATIONS; index++) {
          scope.consumeTransactionOperation();
        }
        scope.consumeTransactionOperation();
      }),
    ).rejects.toMatchObject({ category: "INTERNAL", phase: "transaction" });

    await expect(
      scope.runWithTransaction(tx, async () => {
        scope.consumeTransactionOperation();
        return "reached";
      }),
    ).resolves.toBe("reached");
  });
});
