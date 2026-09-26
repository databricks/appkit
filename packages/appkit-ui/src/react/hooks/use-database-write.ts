import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { DatabaseApiError } from "@/js/database/errors";

import {
  asDatabaseApiError,
  type DatabaseInvalidation,
  invalidateDatabaseReads,
} from "./database-request-store";

export type { DatabaseInvalidation } from "./database-request-store";

/** Options shared by the database write hooks. */
export interface DatabaseWriteOptions {
  /**
   * Reads to restart once a write succeeds. Default `true`: an include can
   * reach this entity from any other, and the relation is not visible at
   * runtime, so every mounted database read restarts.
   */
  invalidate?: DatabaseInvalidation;
}

/** Latest state of a database write hook. */
export interface DatabaseWriteState<T> {
  /** The latest call's result, or `null` before it answers. */
  data: T | null;
  /** Whether the latest call is in flight. */
  loading: boolean;
  /** Why the latest call failed; `NOT_EXPOSED` when no route exists. */
  error: DatabaseApiError | null;
}

interface DatabaseWrite<
  Args extends unknown[],
  T,
> extends DatabaseWriteState<T> {
  mutate(...args: Args): Promise<T | null>;
  reset(): void;
}

const IDLE: DatabaseWriteState<never> = {
  data: null,
  loading: false,
  error: null,
};

/** Keep an inline entity list from changing the write's identity each render. */
function useInvalidationScope(
  invalidate: DatabaseInvalidation,
): DatabaseInvalidation {
  const key =
    typeof invalidate === "boolean"
      ? String(invalidate)
      : JSON.stringify(invalidate);
  return useMemo(
    () => (typeof invalidate === "boolean" ? invalidate : [...invalidate]),
    [key],
  );
}

/**
 * One write hook's state around `send`, which must be stable per entity.
 *
 * A call never rejects, like `useServingInvoke`: it resolves with the result,
 * or with `null` once the failure is in `error`, so a handler needs no
 * `try/catch`. Callers that want an exception use `databaseApi` directly.
 *
 * A write is never aborted: cancelling the request would not undo a committed
 * transaction. Only the latest call of a mounted hook updates its state, and
 * a successful write restarts reads even after the hook unmounts, since the
 * rows did change. A call resolves once its state and reads are updated.
 */
export function useDatabaseWrite<Args extends unknown[], T>(
  send: (...args: Args) => Promise<T>,
  invalidate: DatabaseInvalidation,
): DatabaseWrite<Args, T> {
  const [state, setState] = useState<DatabaseWriteState<T>>(IDLE);
  const mounted = useRef(true);
  const latest = useRef<symbol | null>(null);
  const scope = useInvalidationScope(invalidate);

  // Set on every setup as well: a StrictMode remount runs cleanup first.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const mutate = useCallback(
    async (...args: Args): Promise<T | null> => {
      const call = Symbol("database write");
      latest.current = call;
      const settle = (next: DatabaseWriteState<T>) => {
        if (mounted.current && latest.current === call) setState(next);
      };

      settle({ data: null, loading: true, error: null });
      let data: T;
      try {
        data = await send(...args);
      } catch (cause) {
        settle({
          data: null,
          loading: false,
          error: asDatabaseApiError(cause),
        });
        return null;
      }
      settle({ data, loading: false, error: null });
      invalidateDatabaseReads(scope);
      return data;
    },
    [send, scope],
  );

  // A call still in flight keeps running, but no longer reports here.
  const reset = useCallback(() => {
    latest.current = null;
    if (mounted.current) setState(IDLE);
  }, []);

  return { ...state, mutate, reset };
}
