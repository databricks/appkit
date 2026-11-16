import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { DatabaseQueryEncodingError } from "shared";

import {
  type DatabaseOperation,
  type IdLike,
  resolveDatabaseUrl,
} from "@/js/database/client";
import { DatabaseApiError, invalidDatabaseQuery } from "@/js/database/errors";

import {
  databaseReadScope,
  getDatabaseReadSnapshot,
  IDLE_DATABASE_READ,
  retainDatabaseRead,
  startDatabaseRead,
  subscribeDatabaseRead,
} from "./database-request-store";

/** Options shared by `useDatabaseList` and `useDatabaseRecord`. */
export interface UseDatabaseReadOptions {
  /** Send the request. `false` keeps the hook idle and sends nothing. Default true. */
  enabled?: boolean;
  /**
   * While new params load, keep showing the previous params' `data` instead
   * of `null`, so a paginated list does not blank between pages. `loading`
   * stays true until the new response arrives. Default false.
   */
  keepPreviousData?: boolean;
}

/** Latest state of one database read. */
export interface UseDatabaseReadResult<T> {
  /**
   * The last successful response, or `null` before one arrives. A refetch
   * keeps it visible while it loads and after it fails, except a `NOT_FOUND`,
   * which clears it.
   */
  data: T | null;
  /** Whether a request for the current params is in flight. */
  loading: boolean;
  /**
   * Why the latest request failed: `NOT_EXPOSED` when no route exists,
   * `INVALID_REQUEST` for params or an id that cannot be sent. Stable across
   * renders.
   */
  error: DatabaseApiError | null;
  /** Abort any in-flight request and send it again. No-op while disabled. */
  refetch: () => void;
}

/** What one read hook asks `useDatabaseRead` to subscribe to. */
export interface DatabaseReadRequest {
  entity: string;
  operation: Extract<DatabaseOperation, "list" | "detail">;
  id: IdLike | undefined;
  /** Encoded params, a known validation failure, or `null` for an unknown failure. */
  query: string | DatabaseQueryEncodingError | null;
  /** The params' include tree, to find the tables the read shows. */
  include: unknown;
  enabled: boolean;
  accept: (body: unknown) => body is object;
  keepPreviousData: boolean;
}

type Route = { url: string } | { error: DatabaseApiError } | null;

const noop = () => {};

/**
 * One subscribed read, keyed by the resolved URL so params with equal encoded
 * values share a request whatever their object identity. A route the server
 * did not publish resolves to a stable `NOT_EXPOSED` error without a request,
 * and params that cannot be encoded to a stable `INVALID_REQUEST`.
 */
export function useDatabaseRead({
  entity,
  operation,
  id,
  query,
  include,
  enabled,
  accept,
  keepPreviousData,
}: DatabaseReadRequest): UseDatabaseReadResult<unknown> {
  const encodedQuery = typeof query === "string" ? query : null;
  // Encoding runs every render; only the safe failure fields define its identity.
  const parameter =
    query instanceof DatabaseQueryEncodingError ? query.parameter : undefined;
  const message =
    query instanceof DatabaseQueryEncodingError ? query.message : undefined;
  const route = useMemo((): Route => {
    if (!enabled) return null;
    if (encodedQuery === null) {
      const cause =
        parameter !== undefined && message !== undefined
          ? new DatabaseQueryEncodingError(parameter, message)
          : undefined;
      return { error: invalidDatabaseQuery(cause) };
    }
    try {
      return { url: resolveDatabaseUrl(entity, operation, id, encodedQuery) };
    } catch (error) {
      if (error instanceof DatabaseApiError) return { error };
      throw error;
    }
  }, [enabled, entity, operation, id, encodedQuery, parameter, message]);

  const url = route !== null && "url" in route ? route.url : null;
  const routeError = route !== null && "error" in route ? route.error : null;

  // Every subscriber of one URL encodes the same include, so the URL is the
  // include tree's identity; the object passed in may be a fresh literal.
  const scope = useMemo(
    () => (url === null ? null : databaseReadScope(entity, include)),
    [url],
  );

  const subscribe = useCallback(
    (listener: () => void) =>
      url === null ? noop : subscribeDatabaseRead(url, listener),
    [url],
  );
  const getSnapshot = useCallback(
    () => (url === null ? IDLE_DATABASE_READ : getDatabaseReadSnapshot(url)),
    [url],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // The first subscriber of a URL starts the request; later ones share it.
  useEffect(() => {
    if (url === null || scope === null) return;
    return retainDatabaseRead(url, accept, scope);
  }, [url, accept, scope]);

  const refetch = useCallback(() => {
    if (url !== null) startDatabaseRead(url);
  }, [url]);

  // Until the effect retains a new URL, its request is about to start.
  const loading =
    snapshot.loading || (url !== null && snapshot === IDLE_DATABASE_READ);
  const error = routeError ?? snapshot.error;

  // The last data this hook showed for a URL, to hold across a params change.
  const previous = useRef<{ url: string; data: unknown } | null>(null);
  useEffect(() => {
    if (url !== null && snapshot.data !== null) {
      previous.current = { url, data: snapshot.data };
    }
  }, [url, snapshot.data]);

  let data = snapshot.data;
  if (
    keepPreviousData &&
    data === null &&
    loading &&
    error === null &&
    previous.current !== null &&
    previous.current.url !== url
  ) {
    data = previous.current.data;
  }

  return { data, loading, error, refetch };
}
