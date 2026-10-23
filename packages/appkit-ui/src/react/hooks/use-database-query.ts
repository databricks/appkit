import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import {
  type DatabaseOperationCall,
  prepareDatabaseOperation,
} from "@/js/database/client";
import {
  asDatabaseApiError,
  type DatabaseApiError,
} from "@/js/database/errors";
import {
  getDatabaseSessionEpoch,
  subscribeDatabaseSession,
} from "@/js/database/session";
import type {
  DatabaseOperationInput,
  DatabaseOperationOutput,
  DatabaseQueryName,
} from "@/js/database/types";

/** Options for {@link useDatabaseQuery}. */
export interface UseDatabaseQueryOptions {
  /** `false` holds the query idle and sends nothing. Default true. */
  readonly enabled?: boolean;
}

/** Latest state of one {@link useDatabaseQuery}. */
export interface UseDatabaseQueryResult<T> {
  /**
   * The answer for the current name and input, or `undefined` until it
   * arrives. A refetch keeps it visible while it loads; a new input, a failed
   * request, and a session change clear it.
   */
  readonly data: T | undefined;
  /** Whether a request for the current name and input is in flight. */
  readonly isLoading: boolean;
  /**
   * Why the latest request failed: `NOT_EXPOSED` when the server published no
   * such query, `INVALID_REQUEST` for an input that cannot be sent,
   * `UNAUTHENTICATED` once the session ended.
   */
  readonly error: DatabaseApiError | null;
  /** Abort any request in flight and send it again. No-op while idle. */
  readonly refetch: () => void;
}

interface QueryState {
  readonly url: string;
  readonly epoch: number;
  readonly data: unknown;
  readonly error: DatabaseApiError | null;
  readonly isLoading: boolean;
}

type Prepared =
  | { readonly call: DatabaseOperationCall }
  | { readonly error: DatabaseApiError };

let restarts = 0;
const restartListeners = new Set<() => void>();

function subscribeRestarts(listener: () => void): () => void {
  restartListeners.add(listener);
  return () => {
    restartListeners.delete(listener);
  };
}

const getRestarts = () => restarts;

/**
 * Send every mounted query again, keeping its data visible while it loads.
 * A successful mutation calls this, since an operation can change any row.
 *
 * @internal Shared with `useDatabaseMutation`; not part of the public surface.
 */
export function restartDatabaseQueries(): void {
  restarts += 1;
  for (const listener of [...restartListeners]) listener();
}

function prepare(name: string, input: unknown): Prepared {
  try {
    return { call: prepareDatabaseOperation(name, input, "query") };
  } catch (error) {
    return { error: asDatabaseApiError(error) };
  }
}

/**
 * Read one named GET operation. The name, input, and data are typed from the
 * generated `database-operations.d.ts`; the URL comes from the endpoints the server
 * published, so a name it did not publish reports `NOT_EXPOSED` without a
 * request.
 *
 * Each hook sends its own request; nothing is shared or cached between hooks.
 * A new input aborts the previous request and clears its data and error;
 * unmounting aborts too. When another reply shows the signed-in actor changed or
 * the session ended, every query drops its data and asks again. A successful
 * {@link useDatabaseMutation} restarts every mounted query.
 *
 * @param name - A GET operation the generated registry declares
 * @param input - The operation's JSON input; an equal value on a later render
 *   keeps the request in flight
 * @param options - `enabled: false` holds the query idle
 * @returns The data, loading and error state, and `refetch`
 *
 * @example
 * ```tsx
 * const note = useDatabaseQuery("notes.get", { id: noteId });
 * if (note.isLoading) return <Spinner />;
 * return <p>{note.data?.body}</p>;
 * ```
 */
export function useDatabaseQuery<N extends DatabaseQueryName>(
  name: N,
  input: DatabaseOperationInput<N>,
  options: UseDatabaseQueryOptions = {},
): UseDatabaseQueryResult<DatabaseOperationOutput<N>> {
  const enabled = options.enabled ?? true;
  // Preparation encodes the input every render, so its URL is the identity
  // of a request whatever the input object's identity.
  const fresh = enabled ? prepare(name, input) : null;
  const identity =
    fresh === null
      ? null
      : "call" in fresh
        ? fresh.call.url
        : `${fresh.error.code}\0${fresh.error.message}`;
  const prepared = useMemo(() => fresh, [identity]);
  const call = prepared !== null && "call" in prepared ? prepared.call : null;

  const epoch = useSyncExternalStore(
    subscribeDatabaseSession,
    getDatabaseSessionEpoch,
    getDatabaseSessionEpoch,
  );
  const restart = useSyncExternalStore(
    subscribeRestarts,
    getRestarts,
    getRestarts,
  );
  const [refetches, setRefetches] = useState(0);
  const [state, setState] = useState<QueryState | null>(null);

  useEffect(() => {
    if (call === null) {
      // A disabled or invalid query forgets its answer, so re-enabling it
      // never shows that answer as settled before it is asked again.
      setState(null);
      return;
    }
    const controller = new AbortController();
    const { url } = call;
    setState((previous) =>
      previous?.url === url && previous.epoch === epoch
        ? { ...previous, isLoading: true }
        : { url, epoch, data: undefined, error: null, isLoading: true },
    );
    const settle = (data: unknown, error: DatabaseApiError | null) => {
      if (!controller.signal.aborted) {
        setState({ url, epoch, data, error, isLoading: false });
      }
    };
    call.send(controller.signal).then(
      (data) => settle(data, null),
      (cause: unknown) => settle(undefined, asDatabaseApiError(cause)),
    );
    return () => controller.abort();
  }, [call, epoch, restart, refetches]);

  const refetch = useCallback(() => {
    if (call !== null) setRefetches((count) => count + 1);
  }, [call]);

  let view: Omit<QueryState, "url" | "epoch">;
  if (prepared === null) {
    view = { data: undefined, error: null, isLoading: false };
  } else if ("error" in prepared) {
    view = { data: undefined, error: prepared.error, isLoading: false };
  } else if (state?.url !== prepared.call.url || state.epoch !== epoch) {
    // Before the effect starts this input's request, nothing of the previous
    // input or session may show.
    view = { data: undefined, error: null, isLoading: true };
  } else {
    view = state;
  }
  return {
    // Generation describes the JSON this operation's route answers with.
    data: view.data as DatabaseOperationOutput<N> | undefined,
    isLoading: view.isLoading,
    error: view.error,
    refetch,
  };
}
