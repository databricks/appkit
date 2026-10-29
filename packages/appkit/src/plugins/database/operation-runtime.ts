import { context, type Span, SpanStatusCode } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import express, {
  type Request,
  type RequestHandler,
  type Response,
} from "express";

import {
  classifyDatabaseError,
  DatabasePluginError,
  databaseErrorFromStatus,
  databaseSetupFailed,
  invalidDatabaseInput,
} from "../../database/errors";
import type { Row } from "../../database/runtime";
import type { Schema } from "../../database/schema-builder";
import { DatabaseValidationError } from "../../errors";
import { createLogger } from "../../logging/logger";
import type { ITelemetry } from "../../telemetry";
import type { JsonValue } from "./crud/codecs";
import {
  boundedJson,
  compileCrudTables,
  type CrudTable,
  isPlainObject,
} from "./crud/contract";
import { decodeCreateBody, decodeUpdateBody } from "./crud/request";
import { sendEmpty, sendJson } from "./crud/response";
import { MAX_OPERATION_BODY_BYTES, MAX_QUERY_BYTES } from "./defaults";
import type { DatabaseExports } from "./entity-types";
import { type ActorResolver, isSameOriginRequest } from "./operation-actor";
import {
  MAX_OPERATION_NAME_LENGTH,
  type validateOperationMetadata,
} from "./operation-metadata";
import type { OperationAppKit, OperationMethod } from "./operations";

const logger = createLogger("database:operations");

/** One declaration exactly as the shared metadata validator admits it. */
type ValidatedOperation = ReturnType<
  typeof validateOperationMetadata
>["operations"][number];

/**
 * Every authenticated response carries this opaque session discriminator: the
 * SHA-256 of the workspace host, NUL, and the canonical actor id. It is not a
 * credential and names no one; a 401 never carries it.
 */
const DATABASE_ACTOR_HEADER = "x-appkit-database-actor";

/** Mount point below the plugin router: `router.use(OPERATIONS_PATH, handler)`. */
export const OPERATIONS_PATH = "/operations";

/** Where one operation answers below the plugin router: its name as one encoded segment. */
export function operationPath(name: string): string {
  return `${OPERATIONS_PATH}/${encodeURIComponent(name)}`;
}

/** Methods whose `null` result is a missing record unless an output accepts it. */
const NULLABLE_METHODS: ReadonlySet<OperationMethod> = new Set([
  "GET",
  "PATCH",
  "PUT",
]);

/** The service-principal handles an operation reaches. */
interface OperationServices {
  readonly db: DatabaseExports;
  readonly appkit: OperationAppKit;
}

interface OperationHandlerOptions {
  readonly schema: Schema;
  readonly operations: readonly ValidatedOperation[];
  readonly resolveActor: ActorResolver;
  /** Read per admitted request, so a draining plugin serves no stale client. */
  readonly services: () => OperationServices;
  readonly telemetry: Pick<ITelemetry, "startActiveSpan">;
}

type Reply =
  | { readonly status: 200 | 201; readonly body: JsonValue }
  | { readonly status: 204 };

type Decode = (raw: JsonValue) => unknown;

/** Validate an answer and shape the reply; a schema may refine asynchronously. */
type Respond = (result: unknown) => Reply | Promise<Reply>;

interface CompiledOperation {
  readonly name: string;
  readonly method: OperationMethod;
  readonly decode: Decode;
  readonly authorize: ValidatedOperation["authorize"];
  readonly execute: ValidatedOperation["execute"];
  readonly reply: Respond;
}

/** Where a request stopped. A span attribute, never part of a response. */
type Stage =
  | "actor"
  | "origin"
  | "route"
  | "input"
  | "resource"
  | "allow"
  | "execute"
  | "output";

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** Public scalar columns only; a relation is never part of a default reply. */
function publicColumns(table: CrudTable, row: unknown): JsonValue {
  if (!isPlainObject(row)) throw new DatabasePluginError("INTERNAL", "read");
  const out: Record<string, JsonValue> = {};
  for (const [name, value] of Object.entries(row)) {
    const column = table.columns.get(name);
    if (column && !column.meta.isPrivate) out[name] = column.encode(value);
  }
  return out;
}

function rowOrMissing(table: CrudTable): (result: unknown) => Reply {
  return (result) => {
    if (result === null) throw new DatabasePluginError("NOT_FOUND", "read");
    return { status: 200, body: publicColumns(table, result) };
  };
}

/** Refuse a body that leaves out a column the contract requires. */
function requireColumns(columns: Iterable<string>, values: Row): Row {
  for (const column of columns) {
    if (!Object.hasOwn(values, column)) {
      throw invalidDatabaseInput([column], "Required");
    }
  }
  return values;
}

/**
 * Decode one member of a keyed input, naming its refusals inside it: a field
 * detail reads `["changes", "title"]`, and a refusal of the whole member reads
 * `["changes"]`.
 */
function member(
  name: "changes" | "values",
  decode: (raw: unknown) => Row,
): {
  readonly name: "changes" | "values";
  readonly decode: (raw: unknown) => Row;
} {
  return {
    name,
    decode: (raw) => {
      try {
        return decode(raw);
      } catch (error) {
        if (!(error instanceof DatabasePluginError) || !error.details) {
          throw error;
        }
        throw new DatabasePluginError(
          error.category,
          error.phase,
          undefined,
          error.details.map((detail) => ({
            path:
              detail.path.length === 1 && detail.path[0] === "body"
                ? [name]
                : [name, ...detail.path],
            message: detail.message,
          })),
        );
      }
    },
  };
}

/** `{ id }`, plus one member of column values for an update. */
function keyedInput(
  table: CrudTable,
  member?: {
    readonly name: "changes" | "values";
    readonly decode: (raw: unknown) => Row;
  },
): Decode | undefined {
  const key = table.primaryKey;
  if (!key) return undefined;
  const members = new Set(member ? ["id", member.name] : ["id"]);
  return (raw) => {
    if (
      !isPlainObject(raw) ||
      Object.keys(raw).some((name) => !members.has(name))
    ) {
      throw invalidDatabaseInput(["input"], "Unexpected input shape");
    }
    const id = key.decode(raw.id);
    if (id === undefined) {
      throw invalidDatabaseInput(["id"], "Not a valid identifier");
    }
    return member
      ? { id, [member.name]: member.decode(raw[member.name]) }
      : { id };
  };
}

/**
 * The conventional contract of each method, compiled from the table's public
 * HTTP facet. An `undefined` input means the table has no default for that
 * method, so the operation must declare its own.
 */
const DEFAULTS: Readonly<
  Record<
    OperationMethod,
    {
      readonly input: (table: CrudTable) => Decode | undefined;
      readonly reply: (table: CrudTable) => (result: unknown) => Reply;
    }
  >
> = {
  GET: { input: (table) => keyedInput(table), reply: rowOrMissing },
  POST: {
    input: (table) => {
      const required = [...table.creatable].filter((name) => {
        const meta = table.columns.get(name)?.meta;
        return meta?.notNull && !meta.hasDefault;
      });
      return (raw) => requireColumns(required, decodeCreateBody(table, raw));
    },
    reply: (table) => (result) => ({
      status: 201,
      body: publicColumns(table, result),
    }),
  },
  PATCH: {
    input: (table) =>
      table.updatable.size === 0
        ? undefined
        : keyedInput(
            table,
            member("changes", (raw) => {
              const changes = decodeUpdateBody(table, raw);
              if (Object.keys(changes).length === 0) {
                throw invalidDatabaseInput(
                  ["body"],
                  "Expected at least one change",
                );
              }
              return changes;
            }),
          ),
    reply: rowOrMissing,
  },
  PUT: {
    input: (table) =>
      table.updatable.size === 0
        ? undefined
        : keyedInput(
            table,
            member("values", (raw) =>
              requireColumns(table.updatable, decodeUpdateBody(table, raw)),
            ),
          ),
    reply: rowOrMissing,
  },
  DELETE: {
    input: (table) => keyedInput(table),
    reply: () => (result) => {
      if (result === true) return { status: 204 };
      throw new DatabasePluginError(
        result === false ? "NOT_FOUND" : "INTERNAL",
        "write",
      );
    },
  },
};

type Parse = (
  value: unknown,
) => Promise<
  { readonly ok: true; readonly data: unknown } | { readonly ok: false }
>;

function setupFailed(
  operation: ValidatedOperation,
  problem: string,
): DatabasePluginError {
  return databaseSetupFailed(
    `${operation.file}#${operation.exportName} ${problem}`,
  );
}

/**
 * Narrow a validated schema slot once; only the parse result is read back.
 * Parsing is asynchronous, so async refinements and transforms run too.
 */
function parserOf(operation: ValidatedOperation, schema: object): Parse {
  const safeParseAsync: unknown = Reflect.get(schema, "safeParseAsync");
  if (typeof safeParseAsync !== "function") {
    throw setupFailed(operation, "has a schema without safeParseAsync.");
  }
  return async (value) => {
    const result: unknown = await Reflect.apply(safeParseAsync, schema, [
      value,
    ]);
    return typeof result === "object" &&
      result !== null &&
      Reflect.get(result, "success") === true
      ? { ok: true, data: Reflect.get(result, "data") }
      : { ok: false };
  };
}

function schemaInput(parse: Parse): Decode {
  return async (raw) => {
    const parsed = await parse(raw);
    // Zod issues can quote caller keys, so the refusal stays opaque.
    if (!parsed.ok) throw new DatabasePluginError("INVALID_REQUEST", "read");
    return parsed.data;
  };
}

function schemaReply(method: OperationMethod, parse: Parse): Respond {
  return async (result) => {
    const parsed = await parse(result);
    if (!parsed.ok) {
      throw new DatabasePluginError(
        result === null && NULLABLE_METHODS.has(method)
          ? "NOT_FOUND"
          : "INTERNAL",
        "read",
      );
    }
    if (parsed.data === undefined) return { status: 204 };
    let body: JsonValue;
    try {
      body = boundedJson(parsed.data);
    } catch {
      throw new DatabasePluginError("INTERNAL", "read");
    }
    return { status: method === "POST" ? 201 : 200, body };
  };
}

/** Compile every declaration once; a contract that cannot be honored fails setup. */
function compileOperations(
  schema: Schema,
  operations: readonly ValidatedOperation[],
): ReadonlyMap<string, CompiledOperation> {
  const tables = compileCrudTables(schema.$tables);
  const registry = new Map<string, CompiledOperation>();
  for (const operation of operations) {
    const table = tables.get(operation.entity);
    if (!table) {
      throw setupFailed(operation, "names an entity the schema lacks.");
    }
    const defaults = DEFAULTS[operation.method];
    const decode = operation.input
      ? schemaInput(parserOf(operation, operation.input))
      : defaults.input(table);
    if (!decode) {
      throw setupFailed(
        operation,
        `needs an explicit input: ${operation.entity} has no default ${operation.method} input.`,
      );
    }
    registry.set(operation.name, {
      name: operation.name,
      method: operation.method,
      decode,
      authorize: operation.authorize,
      execute: operation.execute,
      reply: operation.output
        ? schemaReply(operation.method, parserOf(operation, operation.output))
        : defaults.reply(table),
    });
  }
  return registry;
}

/** Express keeps the raw query in the URL; decoding it is the handler's job. */
function rawQuery(req: Request): string {
  const url = req.originalUrl ?? req.url;
  const start = url.indexOf("?");
  return start === -1 ? "" : url.slice(start + 1);
}

/** A GET carries exactly one `input` parameter holding bounded JSON. */
function queryInput(req: Request): JsonValue {
  const query = rawQuery(req);
  if (Buffer.byteLength(query, "utf8") > MAX_QUERY_BYTES) {
    throw invalidDatabaseInput(["input"], "Input exceeds the maximum size");
  }
  const [entry, ...rest] = new URLSearchParams(query);
  if (!entry || rest.length > 0 || entry[0] !== "input") {
    throw invalidDatabaseInput(["input"], "Expected one JSON input parameter");
  }
  let value: unknown;
  try {
    value = JSON.parse(entry[1]);
  } catch {
    throw invalidDatabaseInput(["input"], "Input is not valid JSON");
  }
  return boundedJson(value);
}

const parseJsonBody = express.json({
  limit: MAX_OPERATION_BODY_BYTES,
  inflate: false,
  strict: false,
  type: () => true,
});

function statusOf(error: unknown): number {
  const status =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "status")
      : undefined;
  return typeof status === "number" ? status : 500;
}

/** A write's whole input is one bounded JSON body, read only after authentication. */
async function bodyInput(req: Request, res: Response): Promise<JsonValue> {
  if (rawQuery(req) !== "") {
    throw invalidDatabaseInput(["query"], "Writes accept no query parameters");
  }
  if (req.is("application/json") === false) {
    throw new DatabasePluginError("UNSUPPORTED_MEDIA_TYPE", "write");
  }
  // Something read this body before the caller was known.
  if (req.readableEnded) throw new DatabasePluginError("INTERNAL", "write");
  await new Promise<void>((resolve, reject) => {
    parseJsonBody(req, res, (error?: unknown) =>
      error === undefined
        ? resolve()
        : reject(databaseErrorFromStatus(statusOf(error), "write")),
    );
  });
  return boundedJson(req.body);
}

type Called =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false };

/** Run one authorization callback; a throw is recorded as a refusal. */
async function invoke(
  operation: CompiledOperation,
  callback: (...args: never[]) => unknown,
  argument: object,
): Promise<Called> {
  try {
    const value: unknown = await Reflect.apply(callback, undefined, [argument]);
    return { ok: true, value };
  } catch (error) {
    logger.warn(
      "Operation %s refused: its authorization threw %s",
      operation.name,
      errorName(error),
    );
    return { ok: false };
  }
}

/** Only literal `true` admits; an explicit denial picks 403 or 404. */
function enforce(called: Called, refusal: "FORBIDDEN" | "NOT_FOUND"): void {
  if (called.ok && called.value === true) return;
  const deny =
    called.ok && typeof called.value === "object" && called.value !== null
      ? Reflect.get(called.value, "deny")
      : undefined;
  throw new DatabasePluginError(
    deny === "forbidden"
      ? "FORBIDDEN"
      : deny === "not-found"
        ? "NOT_FOUND"
        : refusal,
    "read",
  );
}

/** The category a failure may reveal; field details only from input decoding. */
function safeFailure(
  error: unknown,
  stage: Stage,
  method: string,
): DatabasePluginError {
  if (error instanceof DatabaseValidationError) {
    return new DatabasePluginError("VALIDATION_FAILED", "write");
  }
  const safe = classifyDatabaseError(
    error,
    method === "GET" ? "read" : "write",
  );
  // Only authentication answers 401, so a client never drops a session otherwise.
  if (safe.category === "UNAUTHENTICATED" && stage !== "actor") {
    return new DatabasePluginError("INTERNAL", safe.phase);
  }
  return stage === "input" || !safe.details
    ? safe
    : new DatabasePluginError(safe.category, safe.phase);
}

/**
 * A write whose answer failed after it ran. The client reports
 * `OUTCOME_UNKNOWN` and refreshes, since the change may have committed.
 */
function sendOutcomeUnknown(res: Response): void {
  if (res.headersSent) return;
  sendJson(res, 500, {
    error: "Database write may have completed",
    outcome: "unknown",
  });
}

function sendFailure(res: Response, failure: DatabasePluginError): void {
  if (res.headersSent) return;
  const details = failure.details?.map((detail) => ({
    path: [...detail.path],
    message: detail.message,
  }));
  sendJson(
    res,
    failure.statusCode,
    details && details.length > 0
      ? { error: failure.clientMessage, details }
      : { error: failure.clientMessage },
  );
}

/**
 * The private HTTP runtime for named operations. Mount it with
 * `router.use(OPERATIONS_PATH, handler)` and keep every body parser off the
 * mount: the caller is authenticated before the body or query is read. Each
 * request resolves its actor once, routes by encoded name and exact method,
 * decodes input, loads at most one resource, admits only literal `true`, then
 * executes once. No response is cacheable.
 */
export function createOperationHandler(
  options: OperationHandlerOptions,
): RequestHandler {
  const registry = compileOperations(options.schema, options.operations);

  function route(req: Request): CompiledOperation | undefined {
    const segment = /^\/([^/]+)$/.exec(req.path)?.[1];
    // A percent-encoded character takes three bytes, so this bounds decoding.
    if (!segment || segment.length > MAX_OPERATION_NAME_LENGTH * 3) {
      return undefined;
    }
    let name: string;
    try {
      name = decodeURIComponent(segment);
    } catch {
      return undefined;
    }
    const operation = registry.get(name);
    // Express answers HEAD with a GET route; an operation answers its own method only.
    return operation?.method === req.method ? operation : undefined;
  }

  async function admit(
    operation: CompiledOperation,
    base: object,
    progress: { stage: Stage },
  ): Promise<unknown> {
    const { authorize } = operation;
    progress.stage = "allow";
    if (typeof authorize === "function") {
      enforce(
        await invoke(operation, authorize, Object.freeze({ ...base })),
        "FORBIDDEN",
      );
      return undefined;
    }
    if (authorize.resource === undefined) {
      enforce(
        await invoke(
          operation,
          authorize.allow,
          Object.freeze({ ...base, resource: undefined }),
        ),
        "FORBIDDEN",
      );
      return undefined;
    }
    progress.stage = "resource";
    const found = await invoke(
      operation,
      authorize.resource,
      Object.freeze({ ...base }),
    );
    // `0`, `false`, and `""` are resources; only null and undefined are missing.
    if (!found.ok || found.value === null || found.value === undefined) {
      throw new DatabasePluginError("NOT_FOUND", "read");
    }
    progress.stage = "allow";
    enforce(
      await invoke(
        operation,
        authorize.allow,
        Object.freeze({ ...base, resource: found.value }),
      ),
      "NOT_FOUND",
    );
    return found.value;
  }

  async function run(
    req: Request,
    res: Response,
    span: Span,
    progress: { stage: Stage },
  ): Promise<Reply> {
    const caller = await options.resolveActor(req);
    if (!caller) throw new DatabasePluginError("UNAUTHENTICATED", "read");
    res.setHeader(DATABASE_ACTOR_HEADER, caller.discriminator);

    progress.stage = "origin";
    if (!isSameOriginRequest(req)) {
      throw new DatabasePluginError("FORBIDDEN", "read");
    }

    progress.stage = "route";
    const operation = route(req);
    if (!operation) throw new DatabasePluginError("NOT_FOUND", "read");
    span.setAttribute("database.operation.name", operation.name);

    progress.stage = "input";
    const input = await operation.decode(
      operation.method === "GET" ? queryInput(req) : await bodyInput(req, res),
    );

    progress.stage = "allow";
    const { db, appkit } = options.services();
    const base = { actor: caller.actor, db, appkit, input };
    const resource = await admit(operation, base, progress);

    progress.stage = "execute";
    const result: unknown = await Reflect.apply(operation.execute, undefined, [
      Object.freeze({ ...base, resource }),
    ]);

    progress.stage = "output";
    return await operation.reply(result);
  }

  return (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    return options.telemetry
      .startActiveSpan(
        "database.operation",
        { attributes: { "http.request.method": req.method } },
        async (span) => {
          const progress: { stage: Stage } = { stage: "actor" };
          try {
            // Lower clients and callbacks run untraced: their spans could
            // carry SQL text, row values, tokens, or raw exception messages.
            const reply = await context.with(
              suppressTracing(context.active()),
              () => run(req, res, span, progress),
            );
            if (reply.status === 204) sendEmpty(res, 204);
            else sendJson(res, reply.status, reply.body);
            span.setAttributes({
              "database.operation.outcome": "success",
              "http.response.status_code": reply.status,
            });
          } catch (error) {
            const failure = safeFailure(error, progress.stage, req.method);
            // Once a write's execute returned, its changes may have committed:
            // anything but the contract's own not-found is an unknown outcome.
            const unknown =
              progress.stage === "output" &&
              req.method !== "GET" &&
              failure.category !== "NOT_FOUND";
            if (unknown) sendOutcomeUnknown(res);
            else sendFailure(res, failure);
            span.setAttributes({
              "database.operation.outcome": unknown
                ? "OUTCOME_UNKNOWN"
                : failure.category,
              "database.operation.stage": progress.stage,
              "http.response.status_code": failure.statusCode,
            });
            if (failure.statusCode >= 500) {
              span.setStatus({ code: SpanStatusCode.ERROR });
            }
          } finally {
            span.end();
          }
        },
      )
      .catch(() => {
        if (!res.headersSent) res.status(500).end();
      });
  };
}
