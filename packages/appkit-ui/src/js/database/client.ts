import {
  type DatabaseErrorDetail,
  type DatabaseListPage,
  databaseErrorCategoryForStatus,
  encodeDatabaseListQuery,
  encodeDatabaseRecordQuery,
  type ExactDatabaseParams,
} from "shared";

import { getClientConfig } from "../config";
import { DatabaseApiError } from "./errors";
import type {
  DatabaseEntity,
  DatabaseId,
  DatabaseKeyedEntity,
  DatabaseListParams,
  DatabaseListRow,
  DatabaseRecordParams,
  DatabaseRecordRow,
} from "./types";

/** Suffix of the endpoint names `DatabasePlugin` publishes for each table. */
export type DatabaseOperation =
  | "list"
  | "detail"
  | "create"
  | "update"
  | "delete";

/** An id as a keyed route addresses it in its path. */
export type IdLike = string | number | bigint;

/** Per-call options for a database request. */
export interface DatabaseRequestOptions {
  /** Cancels the request; the promise then rejects with the abort reason. */
  readonly signal?: AbortSignal;
}

/** Typed calls to the routes `DatabasePlugin` generates under `/api/database`. */
export interface DatabaseApi {
  /**
   * Read one page from `GET /api/database/<entity>`. Rows are public rows as
   * JSON carries them, narrowed by `select` and widened by `include`.
   *
   * @example
   * ```typescript
   * const page = await databaseApi.list("notes", {
   *   where: { board_id: 7 },
   *   order: { created_at: "desc" },
   *   limit: 5,
   * });
   * page.items[0]?.body;
   * ```
   */
  list<
    K extends DatabaseEntity,
    const P extends DatabaseListParams<K> = Record<never, never>,
  >(
    entity: K,
    params?: P & ExactDatabaseParams<P, DatabaseListParams<K>>,
    init?: DatabaseRequestOptions,
  ): Promise<DatabaseListPage<DatabaseListRow<K, P>>>;

  /**
   * Read one row from `GET /api/database/<entity>/:id`. Only entities with a
   * public primary key have this route; a missing row rejects with
   * `NOT_FOUND`.
   *
   * @example
   * ```typescript
   * const board = await databaseApi.get("boards", 7, {
   *   include: { notes: { limit: 20 } },
   * });
   * board.notes.length;
   * ```
   */
  get<
    K extends DatabaseKeyedEntity,
    const P extends DatabaseRecordParams<K> = Record<never, never>,
  >(
    entity: K,
    id: DatabaseId<K>,
    params?: P & ExactDatabaseParams<P, DatabaseRecordParams<K>>,
    init?: DatabaseRequestOptions,
  ): Promise<DatabaseRecordRow<K, P>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Find the route the server published for one operation. The plugin publishes
 * only what its `api` configuration exposes, so a missing entry is refused
 * here with `NOT_EXPOSED` and no request is sent.
 */
export function resolveDatabaseUrl(
  entity: string,
  operation: DatabaseOperation,
  id?: IdLike,
  query?: string,
): string {
  const name = `${entity}.${operation}`;
  const endpoints = getClientConfig().endpoints.database;
  const path =
    isRecord(endpoints) && Object.hasOwn(endpoints, name)
      ? endpoints[name]
      : undefined;
  if (typeof path !== "string") {
    throw new DatabaseApiError(
      "NOT_EXPOSED",
      null,
      `Database operation "${name}" is not exposed`,
    );
  }
  const url =
    id === undefined
      ? path
      : path.replace(":id", encodeURIComponent(String(id)));
  return query ? `${url}?${query}` : url;
}

/** Keep only details shaped like the server's; they name public fields only. */
function publicDetails(value: unknown): DatabaseErrorDetail[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((detail): DatabaseErrorDetail[] =>
    isRecord(detail) &&
    typeof detail.message === "string" &&
    Array.isArray(detail.path) &&
    detail.path.every((segment) => typeof segment === "string")
      ? [{ path: [...detail.path], message: detail.message }]
      : [],
  );
}

/** Decode a failure envelope; a non-JSON body still keeps its category. */
async function failure(response: Response): Promise<DatabaseApiError> {
  const body: unknown = await response.json().catch(() => undefined);
  const envelope = isRecord(body) ? body : {};
  return new DatabaseApiError(
    databaseErrorCategoryForStatus(response.status),
    response.status,
    typeof envelope.error === "string"
      ? envelope.error
      : `Database request failed with status ${response.status}`,
    publicDetails(envelope.details),
  );
}

/**
 * Send one request and decode its JSON body, throwing `DatabaseApiError` for
 * anything but the shape `accept` expects. An abort rejects with the signal's
 * own reason, so a caller can tell cancellation from failure.
 */
export async function requestDatabase<T>(
  url: string,
  init: RequestInit,
  accept: (body: unknown) => body is T,
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new DatabaseApiError(
      "TRANSIENT",
      null,
      "Database request did not reach the server",
      [],
      { cause: error },
    );
  }
  if (!response.ok) throw await failure(response);

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new DatabaseApiError(
      "INTERNAL",
      response.status,
      "Database response is not JSON",
      [],
      { cause: error },
    );
  }
  if (!accept(body)) {
    throw new DatabaseApiError(
      "INTERNAL",
      response.status,
      "Database response has an unexpected shape",
    );
  }
  return body;
}

/** The `{ items, limit, offset }` envelope a list route answers with. */
export function isDatabaseListPage(
  body: unknown,
): body is DatabaseListPage<unknown> {
  return (
    isRecord(body) &&
    Array.isArray(body.items) &&
    typeof body.limit === "number" &&
    typeof body.offset === "number"
  );
}

/** A detail route answers one bare row; a serializer returns an object too. */
export function isDatabaseRow(body: unknown): body is Record<string, unknown> {
  return isRecord(body);
}

async function list<
  K extends DatabaseEntity,
  const P extends DatabaseListParams<K> = Record<never, never>,
>(
  entity: K,
  params?: P & ExactDatabaseParams<P, DatabaseListParams<K>>,
  init: DatabaseRequestOptions = {},
): Promise<DatabaseListPage<DatabaseListRow<K, P>>> {
  const url = resolveDatabaseUrl(
    entity,
    "list",
    undefined,
    encodeDatabaseListQuery(params ?? {}),
  );
  const page = await requestDatabase(
    url,
    { method: "GET", signal: init.signal },
    isDatabaseListPage,
  );
  // The server projected and encoded every row; the types describe that wire.
  return page as DatabaseListPage<DatabaseListRow<K, P>>;
}

async function get<
  K extends DatabaseKeyedEntity,
  const P extends DatabaseRecordParams<K> = Record<never, never>,
>(
  entity: K,
  id: DatabaseId<K>,
  params?: P & ExactDatabaseParams<P, DatabaseRecordParams<K>>,
  init: DatabaseRequestOptions = {},
): Promise<DatabaseRecordRow<K, P>> {
  const url = resolveDatabaseUrl(
    entity,
    "detail",
    id,
    encodeDatabaseRecordQuery(params ?? {}),
  );
  const row = await requestDatabase(
    url,
    { method: "GET", signal: init.signal },
    isDatabaseRow,
  );
  return row as DatabaseRecordRow<K, P>;
}

/**
 * Typed browser client for the routes `DatabasePlugin` generates. Entity names,
 * params, and rows come from the generated `database.d.ts`; routes come from
 * the endpoints the server published in the boot payload.
 */
export const databaseApi: DatabaseApi = { list, get };
