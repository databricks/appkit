import { AsyncLocalStorage } from "node:async_hooks";

import { DatabasePluginError } from "../../database/errors";
import type { TransactionClient } from "./entity-types";
import type { MutationOperation } from "./hooks";

/** How deep hook-issued mutations may nest before the guard rejects. */
const MAX_MUTATION_DEPTH = 8;

interface MutationFrame {
  readonly entity: string;
  readonly operation: MutationOperation;
}

interface ScopeState {
  readonly transaction?: TransactionClient;
  readonly frames: readonly MutationFrame[];
}

/** Instance-owned async context created by `createMutationScope()`. */
export type MutationScope = ReturnType<typeof createMutationScope>;

/**
 * Async context owned by one plugin instance. It carries only the transaction
 * surface a hook may use and the frames that bound hook recursion, so neither
 * two instances nor two concurrent calls can observe each other.
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
      const frames = storage.getStore()?.frames ?? [];
      return storage.run({ transaction, frames }, run);
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
      return storage.run(
        {
          transaction: state?.transaction,
          frames: [...frames, { entity, operation }],
        },
        run,
      );
    },
  };
}
