import { AsyncLocalStorage } from "node:async_hooks";

import { DatabasePluginError } from "../../database/errors";
import type { TransactionClient } from "./entity-types";
import type { MutationOperation } from "./hooks";

/** How deep hook-issued mutations may nest before the guard rejects. */
const MAX_MUTATION_DEPTH = 8;
/** Max database operations admitted by one transaction. */
export const MAX_TRANSACTION_OPERATIONS = 100;

interface MutationFrame {
  readonly entity: string;
  readonly operation: MutationOperation;
}

interface MutationBudget {
  used: number;
}

interface ScopeState {
  readonly transaction?: TransactionClient;
  readonly frames: readonly MutationFrame[];
  readonly budget: MutationBudget;
}

/** Charge one operation to a transaction-owned shared budget. */
function consumeBudget(
  state: ScopeState | undefined,
  phase: "transaction" | "write",
): MutationBudget {
  const budget = state?.budget ?? { used: 0 };
  if (budget.used >= MAX_TRANSACTION_OPERATIONS) {
    throw new DatabasePluginError("INTERNAL", phase);
  }
  budget.used += 1;
  return budget;
}

/** Instance-owned async context created by `createMutationScope()`. */
export type MutationScope = ReturnType<typeof createMutationScope>;

/**
 * Async context owned by one plugin instance. It carries the transaction,
 * mutation budget, and frames that bound recursion, so neither two instances
 * nor two concurrent calls can observe each other.
 */
export function createMutationScope() {
  const storage = new AsyncLocalStorage<ScopeState>();

  return {
    /** The transaction a hook must join, or `undefined` outside one. */
    activeTransaction(): TransactionClient | undefined {
      return storage.getStore()?.transaction;
    },

    /** Publish one transaction to everything the callback awaits. */
    runWithTransaction<T>(
      transaction: TransactionClient,
      run: () => Promise<T>,
    ): Promise<T> {
      const current = storage.getStore();
      return storage.run(
        {
          transaction,
          frames: current?.frames ?? [],
          budget: current?.budget ?? { used: 0 },
        },
        run,
      );
    },

    /** Charge SQL and other direct work bound to the active transaction. */
    consumeTransactionOperation(): void {
      const state = storage.getStore();
      if (state?.transaction) consumeBudget(state, "transaction");
    },

    /** Open one frame, refusing a repeated entity/operation pair or deep nesting. */
    async runMutation<T>(
      entity: string,
      operation: MutationOperation,
      run: () => Promise<T>,
    ): Promise<T> {
      const state = storage.getStore();
      const frames = state?.frames ?? [];
      const repeated = frames.some(
        (frame) => frame.entity === entity && frame.operation === operation,
      );
      if (repeated || frames.length >= MAX_MUTATION_DEPTH) {
        throw new DatabasePluginError("INTERNAL", "write");
      }
      const budget = consumeBudget(state, "write");
      return storage.run(
        {
          transaction: state?.transaction,
          frames: [...frames, { entity, operation }],
          budget,
        },
        run,
      );
    },
  };
}
