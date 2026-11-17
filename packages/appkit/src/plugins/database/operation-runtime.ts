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
import { DatabaseValidationError } from "../../errors";
import { createLogger } from "../../logging/logger";
import type { ITelemetry } from "../../telemetry";
import type { JsonValue } from "./crud/codecs";
import { boundedJson, isPlainObject } from "./crud/contract";
import { sendEmpty, sendJson } from "./crud/response";
import {
  MAX_OPERATION_BODY_BYTES,
  MAX_OUTPUT_NODES,
  MAX_QUERY_BYTES,
} from "./defaults";
import type { DatabaseExports } from "./entity-types";
import { type ActorResolver, isSameOriginRequest } from "./operation-actor";
import {
  MAX_OPERATION_NAME_LENGTH,
  type validateOperationMetadata,
} from "./operation-metadata";
import { inputErrorDetails } from "./operation-validation";
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
  readonly operations: readonly ValidatedOperation[];
  readonly resolveActor: ActorResolver;
  /** Read per admitted request, so a draining plugin serves no stale client. */
  readonly services: () => OperationServices;
  readonly telemetry: Pick<ITelemetry, "startActiveSpan">;
}

type Reply =
  | { readonly status: 200 | 201; readonly body: JsonValue }
  | { readonly status: 204 };

type Decode = (raw: JsonValue | undefined) => unknown;

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
  | "origin"
  | "actor"
  | "route"
  | "input"
  | "resource"
  | "allow"
  | "execute"
  | "output";

interface Progress {
  stage: Stage;
  operation?: string;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

class UnusableOutput extends DatabasePluginError {
  constructor(readonly logReason: string) {
    super("INTERNAL", "read");
  }
}

/** No schema means no parameters; never pass unexpected values to a policy. */
function noInput(raw: JsonValue | undefined): undefined {
  if (
    raw === undefined ||
    (isPlainObject(raw) && Object.keys(raw).length === 0)
  ) {
    return undefined;
  }
  throw invalidDatabaseInput(["input"], "This operation accepts no parameters");
}

function noBody(method: OperationMethod): Respond {
  return (result) => {
    if (result === undefined) return { status: 204 };
    if (result === null && NULLABLE_METHODS.has(method)) {
      throw new DatabasePluginError("NOT_FOUND", "read");
    }
    throw new UnusableOutput("it returned a value but declares no output");
  };
}

type Parse = (
  value: unknown,
) => Promise<
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly error: unknown }
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
      : {
          ok: false,
          error:
            typeof result === "object" && result !== null
              ? Reflect.get(result, "error")
              : undefined,
        };
  };
}

function schemaInput(parse: Parse, schema: object): Decode {
  const details = inputErrorDetails(schema);
  return async (raw) => {
    const parsed = await parse(raw);
    if (!parsed.ok)
      throw new DatabasePluginError(
        "INVALID_REQUEST",
        "read",
        undefined,
        details(parsed.error),
      );
    return parsed.data;
  };
}

function schemaReply(method: OperationMethod, parse: Parse): Respond {
  return async (result) => {
    const parsed = await parse(result).catch((error: unknown) => {
      throw new UnusableOutput(`its output schema threw ${errorName(error)}`);
    });
    if (!parsed.ok) {
      if (result === null && NULLABLE_METHODS.has(method)) {
        throw new DatabasePluginError("NOT_FOUND", "read");
      }
      throw new UnusableOutput("its result does not match its output schema");
    }
    if (parsed.data === undefined) return { status: 204 };
    let body: JsonValue;
    try {
      body = boundedJson(parsed.data, MAX_OUTPUT_NODES);
    } catch {
      throw new UnusableOutput("its result is not bounded JSON");
    }
    return { status: method === "POST" ? 201 : 200, body };
  };
}

/** Compile every declaration once; a contract that cannot be honored fails setup. */
function compileOperations(
  operations: readonly ValidatedOperation[],
): ReadonlyMap<string, CompiledOperation> {
  const registry = new Map<string, CompiledOperation>();
  for (const operation of operations) {
    const decode = operation.input
      ? schemaInput(parserOf(operation, operation.input), operation.input)
      : noInput;
    registry.set(operation.name, {
      name: operation.name,
      method: operation.method,
      decode,
      authorize: operation.authorize,
      execute: operation.execute,
      reply: operation.output
        ? schemaReply(operation.method, parserOf(operation, operation.output))
        : noBody(operation.method),
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

/** A GET may omit input, or carry one bounded JSON input parameter. */
function queryInput(req: Request): JsonValue | undefined {
  const query = rawQuery(req);
  if (query === "") return undefined;
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
async function bodyInput(
  req: Request,
  res: Response,
): Promise<JsonValue | undefined> {
  if (rawQuery(req) !== "") {
    throw invalidDatabaseInput(["query"], "Writes accept no query parameters");
  }
  const hasBody =
    req.headers["transfer-encoding"] !== undefined ||
    Number(req.headers["content-length"]) > 0;
  if (!hasBody) return undefined;
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

function isDatabaseOutage(error: unknown): boolean {
  return (
    error instanceof DatabasePluginError &&
    (error.category === "TRANSIENT" || error.category === "INTERNAL")
  );
}

async function invoke(
  operation: CompiledOperation,
  callback: (...args: never[]) => unknown,
  argument: object,
  onOutage: "fail" | "refuse",
): Promise<Called> {
  try {
    const value: unknown = await Reflect.apply(callback, undefined, [argument]);
    return { ok: true, value };
  } catch (error) {
    if (onOutage === "fail" && isDatabaseOutage(error)) throw error;
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
  const safe =
    error instanceof DatabaseValidationError
      ? new DatabasePluginError("VALIDATION_FAILED", "write")
      : classifyDatabaseError(error, method === "GET" ? "read" : "write");
  // Only authentication answers 401, so a client never drops a session otherwise.
  if (safe.category === "UNAUTHENTICATED" && stage !== "actor") {
    return new DatabasePluginError("INTERNAL", safe.phase);
  }
  // Unusable output, an answer too large to send included, is the server's
  // failure, so only the contract's not-found keeps its category.
  if (stage === "output" && safe.category !== "NOT_FOUND") {
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

function sendReply(res: Response, reply: Reply): void {
  if (reply.status === 204) return sendEmpty(res, 204);
  try {
    sendJson(res, reply.status, reply.body);
  } catch (error) {
    if (
      error instanceof DatabasePluginError &&
      error.category === "PAYLOAD_TOO_LARGE"
    ) {
      throw new UnusableOutput("its answer exceeds the response limit");
    }
    throw error;
  }
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
 * request refuses a foreign browser origin before any workspace call, resolves
 * its actor once, routes by encoded name and exact method, decodes input,
 * loads at most one resource, admits only literal `true`, then executes once.
 * No response is cacheable.
 */
export function createOperationHandler(
  options: OperationHandlerOptions,
): RequestHandler {
  const registry = compileOperations(options.operations);

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
    progress: Progress,
  ): Promise<unknown> {
    const { authorize } = operation;
    progress.stage = "allow";
    if (typeof authorize === "function") {
      enforce(
        await invoke(operation, authorize, Object.freeze({ ...base }), "fail"),
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
          "fail",
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
      "fail",
    );
    // `0`, `false`, and `""` are resources; only null and undefined are missing.
    if (!found.ok || found.value === null || found.value === undefined) {
      throw new DatabasePluginError("NOT_FOUND", "read");
    }
    progress.stage = "allow";
    // A missing record answered 404 above, so a 5xx here would reveal this one exists.
    enforce(
      await invoke(
        operation,
        authorize.allow,
        Object.freeze({ ...base, resource: found.value }),
        "refuse",
      ),
      "NOT_FOUND",
    );
    return found.value;
  }

  async function run(
    req: Request,
    res: Response,
    span: Span,
    progress: Progress,
  ): Promise<Reply> {
    if (!isSameOriginRequest(req)) {
      throw new DatabasePluginError("FORBIDDEN", "read");
    }

    progress.stage = "actor";
    const caller = await options.resolveActor(req);
    if (!caller) throw new DatabasePluginError("UNAUTHENTICATED", "read");
    res.setHeader(DATABASE_ACTOR_HEADER, caller.discriminator);

    progress.stage = "route";
    const operation = route(req);
    if (!operation) throw new DatabasePluginError("NOT_FOUND", "read");
    progress.operation = operation.name;
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
          const progress: Progress = { stage: "origin" };
          try {
            // Lower clients and callbacks run untraced: their spans could
            // carry SQL text, row values, tokens, or raw exception messages.
            const reply = await context.with(
              suppressTracing(context.active()),
              () => run(req, res, span, progress),
            );
            sendReply(res, reply);
            span.setAttributes({
              "database.operation.outcome": "success",
              "http.response.status_code": reply.status,
            });
          } catch (error) {
            const failure = safeFailure(error, progress.stage, req.method);
            if (error instanceof UnusableOutput) {
              logger.warn(
                "Operation %s answered 500: %s",
                progress.operation,
                error.logReason,
              );
            }
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
