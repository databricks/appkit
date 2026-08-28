import { AsyncLocalStorage } from "node:async_hooks";

import { DatabasePluginError } from "../../database/errors";
import type { TransactionClient } from "./entity-types";
import type { MutationOperation } from "./hooks";

/** How deep hook-issued mutations may nest before the guard rejects. */
const MAX_MUTATION_DEPTH = 8;
/** Max entity mutations admitted by one transaction. */
export const MAX_MUTATIONS_PER_TRANSACTION = 100;

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

    /** Open one frame, refusing a repeated entity/operation pair or deep nesting. */
    async runMutation<T>(
      entity: string,
      operation: MutationOperation,
      run: () => Promise<T>,
    ): Promise<T> {
      const state = storage.getStore();
      const frames = state?.frames ?? [];
      const budget = state?.budget ?? { used: 0 };
      const repeated = frames.some(
        (frame) => frame.entity === entity && frame.operation === operation,
      );
      if (
        repeated ||
        frames.length >= MAX_MUTATION_DEPTH ||
        budget.used >= MAX_MUTATIONS_PER_TRANSACTION
      ) {
        throw new DatabasePluginError("INTERNAL", "write");
      }
      budget.used += 1;
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
