import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import {
  type DatabaseOperation,
  type IdLike,
  resolveDatabaseUrl,
} from "@/js/database/client";
import { DatabaseApiError } from "@/js/database/errors";

import {
  databaseReadKey,
  getDatabaseReadSnapshot,
  IDLE_DATABASE_READ,
  retainDatabaseRead,
  startDatabaseRead,
  subscribeDatabaseRead,
} from "./database-request-store";

declare const DATABASE_SHAPE: unique symbol;

/**
 * Phantom marker for the row a read serializer returns. It only carries a
 * type; build one with {@link serialized}.
 */
export interface DatabaseShape<T> {
  readonly [DATABASE_SHAPE]: T;
}

const SERIALIZED = Object.freeze({});

/**
 * Declare the row a read serializer returns for a hook's result. The entity,
 * id, and params stay checked against the generated registry; only the row
 * type is replaced. It is a promise about the server's serializer, not a
 * runtime check.
 *
 * @example
 * ```typescript
 * interface CaseListView { id: number; alert_count: number }
 *
 * const cases = useDatabaseList("cases", { limit: 20 }, {
 *   shape: serialized<CaseListView>(),
 * });
 * cases.data?.items[0]?.alert_count;
 * ```
 */
export function serialized<T>(): DatabaseShape<T> {
  return SERIALIZED as DatabaseShape<T>;
}

/** Options shared by the database read hooks. */
export interface DatabaseReadOptions<Row> {
  /** Send the request. `false` keeps the hook idle and sends nothing. Default true. */
  enabled?: boolean;
  /** The row a read serializer returns, from `serialized<T>()`. */
  shape?: DatabaseShape<Row>;
}

/** Latest state of one database read. */
export interface DatabaseReadResult<T> {
  /**
   * The last successful response, or `null` before one arrives. A refetch
   * keeps it visible while it loads and after it fails.
   */
  data: T | null;
  /** Whether a request for the current params is in flight. */
  loading: boolean;
  /** Why the latest request failed; `NOT_EXPOSED` when no route exists. */
  error: DatabaseApiError | null;
  /** Abort any in-flight request and send it again. No-op while disabled. */
  refetch: () => void;
}

type Route = { url: string } | { error: DatabaseApiError } | null;

const noop = () => {};

/**
 * One subscribed read, keyed by the resolved URL so params with equal encoded
 * values share a request whatever their object identity. A route the server
 * did not publish resolves to a stable `NOT_EXPOSED` error without a request.
 */
export function useDatabaseRead(
  entity: string,
  operation: Extract<DatabaseOperation, "list" | "detail">,
  id: IdLike | undefined,
  query: string,
  enabled: boolean,
  accept: (body: unknown) => body is object,
): DatabaseReadResult<unknown> {
  const route = useMemo((): Route => {
    if (!enabled) return null;
    try {
      return { url: resolveDatabaseUrl(entity, operation, id, query) };
    } catch (error) {
      if (error instanceof DatabaseApiError) return { error };
      throw error;
    }
  }, [enabled, entity, operation, id, query]);

  const url = route !== null && "url" in route ? route.url : null;
  const key = url === null ? null : databaseReadKey(entity, url);

  const subscribe = useCallback(
    (listener: () => void) =>
      key === null ? noop : subscribeDatabaseRead(key, listener),
    [key],
  );
  const getSnapshot = useCallback(
    () => (key === null ? IDLE_DATABASE_READ : getDatabaseReadSnapshot(key)),
    [key],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // The first subscriber of a key starts the request; later ones share it.
  useEffect(() => {
    if (key === null || url === null) return;
    return retainDatabaseRead(key, url, accept);
  }, [key, url, accept]);

  const refetch = useCallback(() => {
    if (key !== null) startDatabaseRead(key);
  }, [key]);

  return {
    data: snapshot.data,
    // Until the effect retains a new key, its request is about to start.
    loading:
      snapshot.loading || (key !== null && snapshot === IDLE_DATABASE_READ),
    error: route !== null && "error" in route ? route.error : snapshot.error,
    refetch,
  };
}
