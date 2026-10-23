import { useCallback, useRef, useState, useSyncExternalStore } from "react";

import { prepareDatabaseOperation } from "@/js/database/client";
import {
  asDatabaseApiError,
  type DatabaseApiError,
} from "@/js/database/errors";
import {
  getDatabaseSessionEpoch,
  subscribeDatabaseSession,
} from "@/js/database/session";
import type {
  DatabaseMutationName,
  DatabaseOperationInput,
  DatabaseOperationOutput,
} from "@/js/database/types";

import { restartDatabaseQueries } from "./use-database-query";

/** How one `mutate` call ended. `error` is `null` exactly when it succeeded. */
export type DatabaseMutationOutcome<T> =
  | { readonly data: T; readonly error: null }
  | { readonly data: undefined; readonly error: DatabaseApiError };

/** What {@link useDatabaseMutation} returns. */
export interface UseDatabaseMutationResult<Input, T> {
  /**
   * Send the write once and resolve with its outcome. It never rejects and
   * is never retried or aborted, since a write may commit before its reply.
   */
  readonly mutate: (input: Input) => Promise<DatabaseMutationOutcome<T>>;
  /** The latest call's answer, or `undefined` until it succeeds. */
  readonly data: T | undefined;
  /** Whether the latest call is in flight. */
  readonly isLoading: boolean;
  /**
   * Why the latest call failed: `NOT_EXPOSED` when the server published no
   * such write, `OUTCOME_UNKNOWN` when it may have committed without a usable
   * reply. Mounted queries restart after success and after `OUTCOME_UNKNOWN`.
   */
  readonly error: DatabaseApiError | null;
  /** Return to idle; a call in flight still runs but no longer reports here. */
  readonly reset: () => void;
}

interface MutationState {
  readonly epoch: number;
  readonly data: unknown;
  readonly error: DatabaseApiError | null;
  readonly isLoading: boolean;
}

const IDLE: MutationState = Object.freeze({
  epoch: -1,
  data: undefined,
  error: null,
  isLoading: false,
});

/**
 * Run one named write operation, only when `mutate` is called; mounting the
 * hook sends nothing. The name, input, and answer are typed from the
 * generated `database-operations.d.ts`. Only the latest call reports in the hook's
 * state, and a session change clears it. A successful call restarts every
 * mounted {@link useDatabaseQuery}.
 *
 * @param name - A POST, PATCH, PUT, or DELETE operation the registry declares
 * @returns `mutate`, the latest call's data, loading and error state, and `reset`
 *
 * @example
 * ```tsx
 * const createNote = useDatabaseMutation("notes.create");
 *
 * async function add(body: string) {
 *   const { error } = await createNote.mutate({ board_id: boardId, body });
 *   if (error === null) setDraft("");
 * }
 * ```
 */
export function useDatabaseMutation<N extends DatabaseMutationName>(
  name: N,
): UseDatabaseMutationResult<
  DatabaseOperationInput<N>,
  DatabaseOperationOutput<N>
> {
  type Output = DatabaseOperationOutput<N>;
  const epoch = useSyncExternalStore(
    subscribeDatabaseSession,
    getDatabaseSessionEpoch,
    getDatabaseSessionEpoch,
  );
  const [state, setState] = useState<MutationState>(IDLE);
  const latest = useRef<symbol | null>(null);

  const mutate = useCallback(
    async (
      input: DatabaseOperationInput<N>,
    ): Promise<DatabaseMutationOutcome<Output>> => {
      const call = Symbol(name);
      latest.current = call;
      const started = getDatabaseSessionEpoch();
      // An answer, even a 401 or a new actor's reply that opens an epoch,
      // belongs to the epoch it was accepted in; a stale one stays in the old.
      const settle = (
        next: Omit<MutationState, "epoch">,
        epoch = getDatabaseSessionEpoch(),
      ) => {
        if (latest.current === call) setState({ ...next, epoch });
      };
      settle({ data: undefined, error: null, isLoading: true }, started);
      try {
        const data = (await prepareDatabaseOperation(
          name,
          input,
          "mutation",
        ).send()) as Output;
        settle({ data, error: null, isLoading: false });
        // A new session restarts every query on its own.
        if (getDatabaseSessionEpoch() === started) restartDatabaseQueries();
        return { data, error: null };
      } catch (cause) {
        const error = asDatabaseApiError(cause);
        settle(
          { data: undefined, error, isLoading: false },
          error.code === "SESSION_CHANGED" ? started : undefined,
        );
        // A write that may have committed refreshes what it may have changed.
        if (
          error.code === "OUTCOME_UNKNOWN" &&
          getDatabaseSessionEpoch() === started
        ) {
          restartDatabaseQueries();
        }
        return { data: undefined, error };
      }
    },
    [name],
  );

  const reset = useCallback(() => {
    latest.current = null;
    setState(IDLE);
  }, []);

  const view = state.epoch === epoch ? state : IDLE;
  return {
    mutate,
    // Generation describes the JSON this operation's route answers with.
    data: view.data as Output | undefined,
    isLoading: view.isLoading,
    error: view.error,
    reset,
  };
}
