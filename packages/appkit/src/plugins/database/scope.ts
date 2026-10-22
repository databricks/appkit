import { AsyncLocalStorage } from "node:async_hooks";

import { DatabasePluginError } from "../../database/errors";
import type { TransactionClient } from "./entity-types";

/** Max database operations admitted by one transaction. */
export const MAX_TRANSACTION_OPERATIONS = 100;

interface TransactionState {
  readonly client: TransactionClient;
  readonly budget: { used: number };
}

/** Instance-owned async context created by `createTransactionScope()`. */
export type TransactionScope = ReturnType<typeof createTransactionScope>;

/**
 * Async context owned by one plugin instance. It carries the open transaction
 * client and the budget that transaction shares, so neither two instances nor
 * two concurrent calls can observe each other.
 */
export function createTransactionScope() {
  const storage = new AsyncLocalStorage<TransactionState>();

  return {
    /** The transaction a later write must join, or `undefined` outside one. */
    activeTransaction(): TransactionClient | undefined {
      return storage.getStore()?.client;
    },

    /** Publish one transaction client to everything the callback awaits. */
    runWithTransaction<T>(
      client: TransactionClient,
      run: () => Promise<T>,
    ): Promise<T> {
      return storage.run({ client, budget: { used: 0 } }, run);
    },

    /**
     * Charge one operation to the active transaction. A root call outside a
     * transaction has no shared budget to charge.
     */
    consumeTransactionOperation(): void {
      const state = storage.getStore();
      if (!state) return;
      if (state.budget.used >= MAX_TRANSACTION_OPERATIONS) {
        throw new DatabasePluginError("INTERNAL", "transaction");
      }
      state.budget.used += 1;
    },
  };
}
