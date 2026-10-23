import {
  type DatabaseErrorDetail,
  type DatabaseOperationMethod,
  databaseErrorCategoryForStatus,
} from "shared";

import { getClientConfig, getPluginClientConfig } from "../config";
import {
  type DatabaseApi as DatabaseEntityApi,
  databaseApi as databaseEntityApi,
} from "./entity-client";
import { DatabaseApiError, invalidDatabaseInput } from "./errors";
import {
  acceptDatabaseReply,
  DATABASE_ACTOR_HEADER,
  isCurrentDatabaseRequest,
  openDatabaseRequest,
} from "./session";
import type {
  DatabaseOperationInput,
  DatabaseOperationName,
  DatabaseOperationOutput,
} from "./types";

/** Per-call options for a database operation. */
export interface DatabaseRequestOptions {
  /**
   * Cancels the call; the promise then rejects with the abort reason.
   * Cancelling a write does not undo it once the server has committed.
   */
  readonly signal?: AbortSignal;
}

/**
 * Typed calls to the operations `DatabasePlugin` publishes, by name. The entity
 * calls remain until the plugin serves operations instead of entity routes.
 */
export interface DatabaseApi extends DatabaseEntityApi {
  /**
   * Call one operation with its declared method and resolve with its JSON
   * answer, or `undefined` when it answers without a body. The name, input,
   * and output come from the generated `database-operations.d.ts`; the URL and method
   * come from what the server published at boot. A name the server did not
   * publish rejects with `NOT_EXPOSED` without a request.
   *
   * @example
   * ```typescript
   * const note = await databaseApi.execute("notes.get", { id: 7 });
   * await databaseApi.execute("notes.delete", { id: note.id });
   * ```
   */
  execute<N extends DatabaseOperationName>(
    name: N,
    input: DatabaseOperationInput<N>,
    options?: DatabaseRequestOptions,
  ): Promise<DatabaseOperationOutput<N>>;
}

/** Which methods a hook runs: a query only GET, a mutation only the others. */
type DatabaseOperationKind = "query" | "mutation";

/**
 * One resolved and encoded call. A query's URL carries its input, so equal
 * inputs share a URL whatever their object identity.
 * @internal Shared with the React hooks; not part of the public surface.
 */
export interface DatabaseOperationCall {
  readonly url: string;
  send(signal?: AbortSignal): Promise<unknown>;
}

const METHODS: ReadonlySet<string> = new Set<DatabaseOperationMethod>([
  "GET",
  "POST",
  "PATCH",
  "PUT",
  "DELETE",
]);
/** An error envelope is a short message and a few details; a longer body is not read. */
const MAX_ERROR_BYTES = 64 * 1024;
/** Far above any operation answer, so a runaway body cannot exhaust the page. */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_TEXT_LENGTH = 500;
const MAX_DETAILS = 20;
const MAX_ACTOR_LENGTH = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMethod(value: unknown): value is DatabaseOperationMethod {
  return typeof value === "string" && METHODS.has(value);
}

function isBoundedText(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_TEXT_LENGTH;
}

/** The input must not travel to another origin, whatever the boot payload says. */
function isSameOrigin(url: string): boolean {
  try {
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

/** An own entry of boot metadata, so no name resolves through a prototype. */
function published(record: unknown, name: string): unknown {
  return isRecord(record) && Object.hasOwn(record, name)
    ? record[name]
    : undefined;
}

function notExposed(name: string, reason: string): DatabaseApiError {
  return new DatabaseApiError(
    "NOT_EXPOSED",
    null,
    `Database operation ${JSON.stringify(String(name).slice(0, 100))} ${reason}`,
  );
}

/**
 * Find the URL and method the server published for `name`. Both come from
 * the boot payload: the URL from the endpoints `Plugin.route` registered, the
 * method from the plugin's client config. Without both, or for the wrong kind
 * of hook, the call is refused with `NOT_EXPOSED` and nothing is sent.
 */
function resolve(
  name: string,
  kind: DatabaseOperationKind | undefined,
): { url: string; method: DatabaseOperationMethod } {
  const url = published(getClientConfig().endpoints.database, name);
  const method = published(
    getPluginClientConfig<{ operations?: unknown }>("database").operations,
    name,
  );
  if (typeof url !== "string" || !isSameOrigin(url) || !isMethod(method)) {
    throw notExposed(name, "is not exposed");
  }
  if (kind === "query" && method !== "GET") {
    throw notExposed(name, "is not a query");
  }
  if (kind === "mutation" && method === "GET") {
    throw notExposed(name, "is not a mutation");
  }
  return { url, method };
}

/** JSON must not turn a non-finite number into null, nor fail on a bigint. */
function jsonValue(_key: string, value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw invalidDatabaseInput(
      "Database input numbers must be finite; use null explicitly to clear a value",
    );
  }
  return typeof value === "bigint" ? value.toString() : value;
}

function encode(input: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(input, jsonValue);
  } catch (error) {
    if (error instanceof DatabaseApiError) throw error;
    throw invalidDatabaseInput();
  }
  // `undefined`, a function, or a symbol has no JSON form at all.
  if (json === undefined) {
    throw invalidDatabaseInput("Database input must be a JSON value");
  }
  return json;
}

/**
 * Resolve and encode one call of `name` without sending it. Throws
 * `NOT_EXPOSED` or `INVALID_REQUEST`; the call's `send` performs one request
 * per invocation and never retries.
 *
 * @internal Shared with the React hooks; not part of the public surface.
 */
export function prepareDatabaseOperation(
  name: string,
  input: unknown,
  kind?: DatabaseOperationKind,
): DatabaseOperationCall {
  const { url: path, method } = resolve(name, kind);
  const json = encode(input);
  if (method === "GET") {
    const url = `${path}?input=${encodeURIComponent(json)}`;
    const init: RequestInit = {
      method,
      cache: "no-store",
      headers: { Accept: "application/json" },
    };
    return { url, send: (signal) => send(url, { ...init, signal }, false) };
  }
  const init: RequestInit = {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: json,
  };
  return { url: path, send: (signal) => send(path, { ...init, signal }, true) };
}

function discard(response: Response): void {
  response.body?.cancel().catch(() => {});
}

/** Read at most `limit` bytes of a body; `null` when it is longer. */
async function readText(
  response: Response,
  limit: number,
): Promise<string | null> {
  if (Number(response.headers.get("Content-Length")) > limit) {
    discard(response);
    return null;
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > limit) {
      reader.cancel().catch(() => {});
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}

/** Keep only bounded details shaped like the server's; they name fields only. */
function publicDetails(value: unknown): DatabaseErrorDetail[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_DETAILS)
    .flatMap((detail): DatabaseErrorDetail[] =>
      isRecord(detail) &&
      isBoundedText(detail.message) &&
      Array.isArray(detail.path) &&
      detail.path.length <= MAX_DETAILS &&
      detail.path.every(isBoundedText)
        ? [{ path: [...detail.path], message: detail.message }]
        : [],
    );
}

/**
 * Decode a failure envelope; an oversized or non-JSON body keeps its category.
 * A write the server answered as `outcome: "unknown"` failed after it ran.
 */
async function failure(
  response: Response,
  write: boolean,
): Promise<DatabaseApiError> {
  const { status } = response;
  const text = await readText(response, MAX_ERROR_BYTES).catch(() => null);
  let body: unknown;
  try {
    body = text === null ? undefined : JSON.parse(text);
  } catch {
    body = undefined;
  }
  const envelope = isRecord(body) ? body : {};
  if (write && envelope.outcome === "unknown") {
    return new DatabaseApiError(
      "OUTCOME_UNKNOWN",
      status,
      "Database write may have completed; check its result before retrying",
    );
  }
  return new DatabaseApiError(
    status === 401 ? "UNAUTHENTICATED" : databaseErrorCategoryForStatus(status),
    status,
    isBoundedText(envelope.error) && envelope.error !== ""
      ? envelope.error
      : `Database request failed with status ${status}`,
    publicDetails(envelope.details),
  );
}

/** A reply that answered but cannot be used; a write may still have committed. */
function unusable(
  write: boolean,
  status: number,
  problem: string,
  cause?: unknown,
): DatabaseApiError {
  return new DatabaseApiError(
    write ? "OUTCOME_UNKNOWN" : "INTERNAL",
    status,
    write
      ? `Database write may have completed; response ${problem}`
      : `Database response ${problem}`,
    [],
    cause === undefined ? undefined : { cause },
  );
}

function sessionChanged(write: boolean): DatabaseApiError {
  return new DatabaseApiError(
    "SESSION_CHANGED",
    null,
    write
      ? "The session changed before the write answered; it may have completed"
      : "The session changed before the read answered",
  );
}

/** The reply's actor, or `undefined` when it names none usable. */
function actorOf(response: Response): string | undefined {
  const actor = response.headers.get(DATABASE_ACTOR_HEADER);
  return actor !== null && actor !== "" && actor.length <= MAX_ACTOR_LENGTH
    ? actor
    : undefined;
}

/**
 * Send one request and decode its JSON answer. A `204` resolves `undefined`.
 * An abort rejects with the signal's own reason, so a caller can tell
 * cancellation from failure. A reply from an earlier session rejects with
 * `SESSION_CHANGED`, and a successful reply that does not name its actor is
 * refused rather than shown.
 */
async function send(
  url: string,
  init: RequestInit,
  write: boolean,
): Promise<unknown> {
  const { signal } = init;
  const ticket = openDatabaseRequest();
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (signal?.aborted) throw error;
    if (!isCurrentDatabaseRequest(ticket)) throw sessionChanged(write);
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

  const actor = response.status === 401 ? null : actorOf(response);
  const current =
    actor === undefined
      ? isCurrentDatabaseRequest(ticket)
      : acceptDatabaseReply(ticket, actor);
  if (!current) {
    discard(response);
    throw sessionChanged(write);
  }
  if (!response.ok) {
    const error = await failure(response, write);
    signal?.throwIfAborted();
    throw error;
  }
  if (actor === undefined) {
    discard(response);
    throw unusable(write, response.status, "does not name its actor");
  }

  let body: unknown;
  if (response.status !== 204) {
    let text: string | null;
    try {
      text = await readText(response, MAX_RESPONSE_BYTES);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw unusable(write, response.status, "could not be read", error);
    }
    if (text === null) throw unusable(write, response.status, "is too large");
    try {
      body = JSON.parse(text);
    } catch (error) {
      throw unusable(write, response.status, "is not JSON", error);
    }
  }
  signal?.throwIfAborted();
  if (!isCurrentDatabaseRequest(ticket)) throw sessionChanged(write);
  return body;
}

/**
 * Typed browser client for the named operations `DatabasePlugin` publishes.
 * Names and JSON types come from the generated `database-operations.d.ts`; URLs and
 * methods come from the server's boot payload.
 */
export const databaseApi: DatabaseApi = {
  ...databaseEntityApi,
  async execute<N extends DatabaseOperationName>(
    name: N,
    input: DatabaseOperationInput<N>,
    options: DatabaseRequestOptions = {},
  ): Promise<DatabaseOperationOutput<N>> {
    const answer = await prepareDatabaseOperation(name, input).send(
      options.signal,
    );
    // Generation describes the JSON this operation's route answers with.
    return answer as DatabaseOperationOutput<N>;
  },
};
