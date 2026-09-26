import {
  type DatabaseErrorDetail,
  type DatabaseListPage,
  type DatabaseListQuery,
  databaseErrorCategoryForStatus,
  encodeDatabaseListQuery,
  encodeDatabaseRecordQuery,
  type ExactDatabaseParams,
} from "shared";

import { getClientConfig } from "../config";
import {
  DatabaseApiError,
  invalidDatabaseQuery,
  invalidDatabaseWrite,
} from "./errors";
import type {
  DatabaseEntity,
  DatabaseId,
  DatabaseInsert,
  DatabaseKeyedEntity,
  DatabaseListParams,
  DatabaseListRow,
  DatabaseRecordParams,
  DatabaseRecordRow,
  DatabaseRow,
  DatabaseUpdate,
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
  /**
   * Cancels the request; the promise then rejects with the abort reason.
   * Cancelling a write does not undo it once the server has committed.
   */
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
  list<K extends DatabaseKeyedEntity>(
    entity: K,
    params?: undefined,
    init?: DatabaseRequestOptions,
  ): Promise<DatabaseListPage<DatabaseListRow<K>>>;
  list<K extends DatabaseEntity, const P extends DatabaseListParams<K>>(
    entity: K,
    params: P & ExactDatabaseParams<P, DatabaseListParams<K>>,
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

  /**
   * Create one row with `POST /api/database/<entity>` and return it as the
   * database holds it after any `beforeCreate` hook. Private, generated, and
   * undeclared fields are compile errors, as the server refuses them.
   *
   * @example
   * ```typescript
   * const note = await databaseApi.create("notes", {
   *   board_id: 7,
   *   author: "ada",
   *   body: "Ship it",
   * });
   * note.id;
   * ```
   */
  create<K extends DatabaseEntity, const V extends DatabaseInsert<K>>(
    entity: K,
    values: V & ExactDatabaseParams<V, DatabaseInsert<K>>,
    init?: DatabaseRequestOptions,
  ): Promise<DatabaseRow<K>>;

  /**
   * Change some fields of one row with `PATCH /api/database/<entity>/:id` and
   * return the updated row. A missing row rejects with `NOT_FOUND`.
   *
   * @example
   * ```typescript
   * await databaseApi.update("notes", 7, { body: "Shipped" });
   * ```
   */
  update<K extends DatabaseKeyedEntity, const V extends DatabaseUpdate<K>>(
    entity: K,
    id: DatabaseId<K>,
    values: V & ExactDatabaseParams<V, DatabaseUpdate<K>>,
    init?: DatabaseRequestOptions,
  ): Promise<DatabaseRow<K>>;

  /**
   * Delete one row with `DELETE /api/database/<entity>/:id`. A missing row
   * rejects with `NOT_FOUND`.
   *
   * @example
   * ```typescript
   * await databaseApi.remove("notes", 7);
   * ```
   */
  remove<K extends DatabaseKeyedEntity>(
    entity: K,
    id: DatabaseId<K>,
    init?: DatabaseRequestOptions,
  ): Promise<void>;
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
 * anything but the shape `accept` expects. A `204` has no body, so `accept`
 * sees `undefined`. An abort rejects with the signal's own reason, so a
 * caller can tell cancellation from failure.
 */
export async function requestDatabase<T>(
  url: string,
  init: RequestInit,
  accept: (body: unknown) => body is T,
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  const write = init.method !== "GET";
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new DatabaseApiError(
      write ? "OUTCOME_UNKNOWN" : "TRANSIENT",
      null,
      write
        ? "Database write may have completed; check its result before retrying"
        : "Database read failed before receiving a response",
      [],
      { cause: error },
    );
  }
  if (!response.ok) throw await failure(response);

  let body: unknown;
  try {
    body = response.status === 204 ? undefined : await response.json();
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new DatabaseApiError(
      write ? "OUTCOME_UNKNOWN" : "INTERNAL",
      response.status,
      write
        ? "Database write may have completed; response is not JSON"
        : "Database response is not JSON",
      [],
      { cause: error },
    );
  }
  if (!accept(body)) {
    throw new DatabaseApiError(
      write ? "OUTCOME_UNKNOWN" : "INTERNAL",
      response.status,
      write
        ? "Database write may have completed; response has an unexpected shape"
        : "Database response has an unexpected shape",
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

/** A delete answers `204` with nothing to decode. */
function isNoContent(body: unknown): body is undefined {
  return body === undefined;
}

/** A write must not lose a non-finite number to JSON's implicit null coercion. */
function jsonWriteValue(_key: string, value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw invalidDatabaseWrite(
      "Database write numbers must be finite; use null explicitly to clear a value",
    );
  }
  return typeof value === "bigint" ? value.toString() : value;
}

/** A write sends its values as a JSON body, the only type its route parses. */
function jsonWrite(
  method: "POST" | "PATCH",
  values: object,
  signal: AbortSignal | undefined,
): RequestInit {
  try {
    return {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values, jsonWriteValue),
      signal,
    };
  } catch (error) {
    if (error instanceof DatabaseApiError) throw error;
    throw invalidDatabaseWrite();
  }
}

/**
 * Untyped create behind `databaseApi.create`; its signature carries the
 * checks, while the entity is still a literal.
 */
async function createDatabaseRow(
  entity: string,
  values: object,
  init: DatabaseRequestOptions = {},
): Promise<Record<string, unknown>> {
  const url = resolveDatabaseUrl(entity, "create");
  return requestDatabase(
    url,
    jsonWrite("POST", values, init.signal),
    isDatabaseRow,
  );
}

/** Untyped update behind `databaseApi.update`. */
async function updateDatabaseRow(
  entity: string,
  id: IdLike,
  values: object,
  init: DatabaseRequestOptions = {},
): Promise<Record<string, unknown>> {
  const url = resolveDatabaseUrl(entity, "update", id);
  return requestDatabase(
    url,
    jsonWrite("PATCH", values, init.signal),
    isDatabaseRow,
  );
}

/** Untyped delete behind `databaseApi.remove`. */
async function deleteDatabaseRow(
  entity: string,
  id: IdLike,
  init: DatabaseRequestOptions = {},
): Promise<void> {
  const url = resolveDatabaseUrl(entity, "delete", id);
  await requestDatabase(
    url,
    { method: "DELETE", signal: init.signal },
    isNoContent,
  );
}

function list<K extends DatabaseKeyedEntity>(
  entity: K,
  params?: undefined,
  init?: DatabaseRequestOptions,
): Promise<DatabaseListPage<DatabaseListRow<K>>>;
function list<K extends DatabaseEntity, const P extends DatabaseListParams<K>>(
  entity: K,
  params: P & ExactDatabaseParams<P, DatabaseListParams<K>>,
  init?: DatabaseRequestOptions,
): Promise<DatabaseListPage<DatabaseListRow<K, P>>>;
async function list(
  entity: string,
  params?: DatabaseListQuery,
  init: DatabaseRequestOptions = {},
): Promise<DatabaseListPage<unknown>> {
  let query: string;
  try {
    query = encodeDatabaseListQuery(params ?? {});
  } catch (error) {
    throw invalidDatabaseQuery(error);
  }
  const url = resolveDatabaseUrl(entity, "list", undefined, query);
  const page = await requestDatabase(
    url,
    { method: "GET", signal: init.signal },
    isDatabaseListPage,
  );
  return page;
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
  let query: string;
  try {
    query = encodeDatabaseRecordQuery(params ?? {});
  } catch (error) {
    throw invalidDatabaseQuery(error);
  }
  const url = resolveDatabaseUrl(entity, "detail", id, query);
  const row = await requestDatabase(
    url,
    { method: "GET", signal: init.signal },
    isDatabaseRow,
  );
  return row as DatabaseRecordRow<K, P>;
}

async function create<
  K extends DatabaseEntity,
  const V extends DatabaseInsert<K>,
>(
  entity: K,
  values: V & ExactDatabaseParams<V, DatabaseInsert<K>>,
  init: DatabaseRequestOptions = {},
): Promise<DatabaseRow<K>> {
  // `values` is an insert object; a still-generic `K` only widens its type.
  const row = await createDatabaseRow(entity, values as object, init);
  // The server projected the row it holds; the types describe that wire.
  return row as DatabaseRow<K>;
}

async function update<
  K extends DatabaseKeyedEntity,
  const V extends DatabaseUpdate<K>,
>(
  entity: K,
  id: DatabaseId<K>,
  values: V & ExactDatabaseParams<V, DatabaseUpdate<K>>,
  init: DatabaseRequestOptions = {},
): Promise<DatabaseRow<K>> {
  const row = await updateDatabaseRow(entity, id, values as object, init);
  return row as DatabaseRow<K>;
}

function remove<K extends DatabaseKeyedEntity>(
  entity: K,
  id: DatabaseId<K>,
  init: DatabaseRequestOptions = {},
): Promise<void> {
  return deleteDatabaseRow(entity, id, init);
}

/**
 * Typed browser client for the routes `DatabasePlugin` generates. Entity names,
 * params, and rows come from the generated `database.d.ts`; routes come from
 * the endpoints the server published in the boot payload.
 */
export const databaseApi: DatabaseApi = { list, get, create, update, remove };
