import { useCallback, useEffect, useRef, useState } from "react";

import type { DatabaseApiError } from "@/js/database/errors";

import {
  asDatabaseApiError,
  type DatabaseInvalidation,
  invalidateDatabaseReads,
} from "./database-request-store";

export type { DatabaseInvalidation } from "./database-request-store";

/** Latest state of a database write hook. */
export interface UseDatabaseWriteState<T> {
  /** The latest call's result, or `null` before it answers. */
  data: T | null;
  /**
   * Whether the latest call is in flight, including the reload of the reads
   * it restarts.
   */
  loading: boolean;
  /**
   * Why the latest call failed: `NOT_EXPOSED` when no route exists,
   * `OUTCOME_UNKNOWN` when it may have committed without an answer.
   */
  error: DatabaseApiError | null;
}

/** Options every database write hook takes. */
export interface UseDatabaseWriteOptions {
  /**
   * Reads to restart once a write succeeds. Default `true`: every mounted
   * database read, since a server hook may write other tables in the same
   * transaction. A table list restarts only the reads that show those tables,
   * directly or through an include; `false` restarts none.
   */
  invalidate?: DatabaseInvalidation;
}

/** The generic write lifecycle's callbacks, before each hook names its args. */
interface WriteCallbacks<Args extends unknown[], T> {
  invalidate?: DatabaseInvalidation;
  onSuccess?: (data: T, args: Args) => void;
  onError?: (error: DatabaseApiError, args: Args) => void;
}

interface DatabaseWrite<
  Args extends unknown[],
  T,
> extends UseDatabaseWriteState<T> {
  mutate(...args: Args): Promise<T | null>;
  reset(): void;
}

const IDLE: UseDatabaseWriteState<never> = Object.freeze({
  data: null,
  loading: false,
  error: null,
});

/**
 * Run a caller's callback without letting it break the write's promise: the
 * call still resolves, and the exception still reaches the page's error
 * handling (and any error tracker) as an uncaught error.
 */
function runCallback(callback: () => void): void {
  try {
    callback();
  } catch (error) {
    if (typeof globalThis.reportError === "function") {
      globalThis.reportError(error);
    } else {
      setTimeout(() => {
        throw error;
      });
    }
  }
}

/**
 * One write hook's state around `send`, which must be stable per entity.
 *
 * A call never rejects, like `useServingInvoke`: it resolves with the result,
 * or with `null` once the failure is in `error`, so a handler needs no
 * `try/catch`. Callers that want an exception use `databaseApi` directly.
 *
 * A write is never aborted: cancelling the request would not undo a committed
 * transaction. A successful call restarts the reads `invalidate` names and
 * resolves once they have reloaded, so a handler that clears its form sees the
 * new rows already on screen. Only the latest call of a hook updates its
 * state; callbacks run for every call, even after the hook unmounts, since the
 * rows did change.
 */
export function useDatabaseWrite<Args extends unknown[], T>(
  send: (...args: Args) => Promise<T>,
  options: WriteCallbacks<Args, T>,
): DatabaseWrite<Args, T> {
  const [state, setState] = useState<UseDatabaseWriteState<T>>(IDLE);
  const latest = useRef<symbol | null>(null);

  // Read at call time, so inline callbacks and an inline `invalidate` list do
  // not change `mutate`'s identity on every render.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const mutate = useCallback(
    async (...args: Args): Promise<T | null> => {
      const call = Symbol("database write");
      latest.current = call;
      // React ignores a state update after unmount, so only staleness matters.
      const settle = (next: UseDatabaseWriteState<T>) => {
        if (latest.current === call) setState(next);
      };

      settle({ data: null, loading: true, error: null });
      let data: T;
      try {
        data = await send(...args);
      } catch (cause) {
        const error = asDatabaseApiError(cause);
        settle({ data: null, loading: false, error });
        const { onError } = optionsRef.current;
        if (onError) runCallback(() => onError(error, args));
        return null;
      }
      // Hold `loading` until the restarted reads answer, so the hook does not
      // report success beside rows that still show the old state.
      await invalidateDatabaseReads(optionsRef.current.invalidate ?? true);
      settle({ data, loading: false, error: null });
      const { onSuccess } = optionsRef.current;
      if (onSuccess) runCallback(() => onSuccess(data, args));
      return data;
    },
    [send],
  );

  // A call still in flight keeps running, but no longer reports here.
  const reset = useCallback(() => {
    latest.current = null;
    setState(IDLE);
  }, []);

  return { ...state, mutate, reset };
}
