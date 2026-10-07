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
 * Declare, without checking, the row a read serializer returns. The entity,
 * id, and params stay checked against the generated registry; only the row
 * type is replaced. It is a promise about the server's serializer, not a
 * runtime check: to check each row, pass a parse function as `shape` instead.
 *
 * @example
 * ```typescript
 * interface NoteCard { id: number; excerpt: string }
 *
 * const notes = useDatabaseList("notes", { limit: 20 }, {
 *   shape: serialized<NoteCard>(),
 * });
 * notes.data?.items[0]?.excerpt;
 * ```
 */
export function serialized<T>(): DatabaseShape<T> {
  return SERIALIZED as DatabaseShape<T>;
}

/**
 * The row a read answers with: `serialized<T>()` to declare it, or a function
 * that checks one decoded row and returns it typed, such as a zod schema's
 * `parse`. A function that throws fails the read with `INTERNAL`.
 */
export type DatabaseRowShape<Row> =
  | DatabaseShape<Row>
  | ((row: unknown) => Row);

/** Options shared by `useDatabaseList` and `useDatabaseRecord`. */
export interface UseDatabaseReadOptions<Row> {
  /** Send the request. `false` keeps the hook idle and sends nothing. Default true. */
  enabled?: boolean;
  /**
   * While new params load, keep showing the previous params' `data` instead
   * of `null`, so a paginated list does not blank between pages. `loading`
   * stays true until the new response arrives. Default false.
   */
  keepPreviousData?: boolean;
  /**
   * The row a read serializer returns. `serialized<T>()` only declares it; a
   * function checks every row at runtime (each list item, or the record) and
   * its return value becomes the row. It runs once per response.
   */
  shape?: DatabaseRowShape<Row>;
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
   * `INVALID_REQUEST` for params or an id that cannot be sent, `INTERNAL`
   * when a `shape` function rejected a row. Stable across renders.
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
  shape: DatabaseRowShape<unknown> | undefined;
}

type Route = { url: string } | { error: DatabaseApiError } | null;

const noop = () => {};

/** Apply a `shape` function to each row of one response. */
function shapeResponse(
  operation: DatabaseReadRequest["operation"],
  data: unknown,
  parse: (row: unknown) => unknown,
): unknown {
  if (operation === "detail") return parse(data);
  const page = data as { items: unknown[] };
  return { ...page, items: page.items.map((row) => parse(row)) };
}

/** The shaped response, or why a row failed its `shape`. */
interface Shaped {
  source: unknown;
  data: unknown;
  error: DatabaseApiError | null;
}

/**
 * Run a `shape` function once per response. The result is cached on the
 * response's identity, not the function's, so an inline arrow does not
 * reparse on every render or give `data` a new identity.
 */
function useShapedData(
  operation: DatabaseReadRequest["operation"],
  source: unknown,
  shape: DatabaseRowShape<unknown> | undefined,
): Shaped {
  const cache = useRef<Shaped | null>(null);
  if (typeof shape !== "function" || source === null) {
    return { source, data: source, error: null };
  }
  const cached = cache.current;
  if (cached !== null && cached.source === source) return cached;
  let shaped: Shaped;
  try {
    shaped = {
      source,
      data: shapeResponse(operation, source, shape),
      error: null,
    };
  } catch (cause) {
    // A schema error may quote row values; keep it in `cause` only.
    shaped = {
      source,
      data: null,
      error: new DatabaseApiError(
        "INTERNAL",
        null,
        "Database response does not match the read's shape",
        [],
        { cause },
      ),
    };
  }
  cache.current = shaped;
  return shaped;
}

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
  shape,
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

  const shaped = useShapedData(operation, snapshot.data, shape);

  // Until the effect retains a new URL, its request is about to start.
  const loading =
    snapshot.loading || (url !== null && snapshot === IDLE_DATABASE_READ);
  const error = routeError ?? snapshot.error ?? shaped.error;

  // The last data this hook showed for a URL, to hold across a params change.
  const previous = useRef<{ url: string; data: unknown } | null>(null);
  useEffect(() => {
    if (url !== null && shaped.data !== null) {
      previous.current = { url, data: shaped.data };
    }
  }, [url, shaped.data]);

  let data = shaped.data;
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
