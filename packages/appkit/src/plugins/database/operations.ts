import { readdir } from "node:fs/promises";
import path from "node:path";

import type { Request } from "express";
import type { z } from "zod";

import {
  DatabasePluginError,
  databaseSetupFailed,
} from "../../database/errors";
import { AppKitError } from "../../errors";
import { createLogger } from "../../logging/logger";
import type { DatabaseExports, TransactionClient } from "./entity-types";

const logger = createLogger("database");

/** The authenticated user a request acts for. Never the database identity. */
export interface Actor {
  readonly userId: string;
  readonly userEmail?: string;
}

/** What `authorize` and `execute` receive. `db` always runs as the app's service principal. */
export interface OperationContext<I> {
  readonly actor: Actor;
  readonly input: I;
  readonly db: TransactionClient;
}

/** Only a literal `true` allows; `false` or `{ deny }` refuses with 403. */
export type PolicyResult = boolean | { readonly deny: string };

export type Policy<I> = (
  context: OperationContext<I>,
) => PolicyResult | Promise<PolicyResult>;

interface OperationDefinition<S extends z.ZodType, R> {
  readonly input: S;
  /** Required: an operation without an authorization decision is never exposed. */
  readonly authorize: Policy<z.infer<S>> | readonly Policy<z.infer<S>>[];
  readonly execute: (context: OperationContext<z.infer<S>>) => Promise<R>;
}

export interface Operation<
  S extends z.ZodType = z.ZodType,
  R = unknown,
> extends OperationDefinition<S, R> {
  readonly kind: "query" | "mutation";
}

// Variance: a registry holds operations of every input and result type.
export type AnyOperation = Operation<any, any>;

/** Operations exposed over HTTP, keyed `"METHOD /path"` under `/api/database`. */
export type DatabaseRoutes = Readonly<Record<string, AnyOperation>>;

/**
 * Marks objects built by the define helpers. A registry symbol, not a
 * module-local WeakSet: a dev loader can evaluate this module twice, and an
 * operation from one copy must still run in the other.
 */
const OPERATION = Symbol.for("@databricks/appkit/database.operation");

function hasPolicies(authorize: unknown): boolean {
  const policies = [authorize].flat();
  return (
    policies.length > 0 &&
    policies.every((policy) => typeof policy === "function")
  );
}

function defineOperation<S extends z.ZodType, R>(
  kind: Operation["kind"],
  definition: OperationDefinition<S, R>,
): Operation<S, R> {
  if (!hasPolicies(definition.authorize)) {
    throw databaseSetupFailed(
      "An operation requires authorize: a policy function or a non-empty array of them.",
    );
  }
  return Object.freeze({ ...definition, kind, [OPERATION]: true });
}

/** A read. Runs `authorize` then `execute` outside a transaction. */
export function defineQuery<S extends z.ZodType, R>(
  definition: OperationDefinition<S, R>,
): Operation<S, R> {
  return defineOperation("query", definition);
}

/** A state change. `authorize` and `execute` share one transaction, so a refusal or failure rolls back. */
export function defineMutation<S extends z.ZodType, R>(
  definition: OperationDefinition<S, R>,
): Operation<S, R> {
  return defineOperation("mutation", definition);
}

/** Type a reusable authorization check; the input type is what the policy reads. */
export function definePolicy<I>(policy: Policy<I>): Policy<I> {
  return policy;
}

/** The mark alone is not trusted: the policies are checked again here. */
export function isOperation(value: unknown): value is AnyOperation {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<PropertyKey, unknown>;
  return (
    candidate[OPERATION] === true &&
    (candidate.kind === "query" || candidate.kind === "mutation") &&
    typeof candidate.execute === "function" &&
    hasPolicies(candidate.authorize)
  );
}

/** A failure whose message is written for the caller: denial, bad input, or a business conflict. */
export class OperationError extends AppKitError {
  readonly code = "OPERATION_ERROR";
  readonly isRetryable = false;

  constructor(
    readonly statusCode: 400 | 401 | 403 | 404 | 409 | 500,
    message: string,
    readonly details?: readonly { path: string; message: string }[],
  ) {
    super(message, { clientMessage: message });
  }
}

const OPERATION_STATUSES = new Set([400, 401, 403, 404, 409, 500]);

/** By shape, not `instanceof`: route files may load another copy of this module. */
export function isOperationError(error: unknown): error is OperationError {
  if (!(error instanceof Error)) return false;
  const candidate = error as Partial<OperationError>;
  return (
    candidate.code === "OPERATION_ERROR" &&
    OPERATION_STATUSES.has(candidate.statusCode as number) &&
    typeof candidate.clientMessage === "string"
  );
}

/** A hook's deliberate rejection, by shape for the same reason. */
function isValidationError(error: unknown): error is Error & {
  clientMessage: string;
  issues: readonly { path: readonly unknown[]; message: string }[];
} {
  return (
    error instanceof Error &&
    (error as { code?: unknown }).code === "DATABASE_VALIDATION_ERROR" &&
    Array.isArray((error as { issues?: unknown }).issues)
  );
}

const AUTHORIZATION_FAILED = "Authorization check failed";

/** Every policy must return exactly `true`; anything else is a refusal or an error. */
async function authorize(
  operation: AnyOperation,
  context: OperationContext<unknown>,
): Promise<void> {
  for (const policy of [operation.authorize].flat() as Policy<unknown>[]) {
    let result: unknown;
    try {
      result = await policy(context);
    } catch (error) {
      // A failed permission lookup is never a decision either way.
      logger.error("Operation policy threw: %O", describe(error));
      throw new OperationError(500, AUTHORIZATION_FAILED);
    }
    if (result === true) continue;
    if (result === false) throw new OperationError(403, "Forbidden");
    if (
      typeof result === "object" &&
      result !== null &&
      typeof (result as { deny?: unknown }).deny === "string"
    ) {
      throw new OperationError(403, (result as { deny: string }).deny);
    }
    // A forgotten `return` must not read as permission.
    logger.error("Operation policy returned a non-decision");
    throw new OperationError(500, AUTHORIZATION_FAILED);
  }
}

/** Log a name, never a message: driver errors can carry SQL, values, or credentials. */
function describe(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * The one execution path for an operation, whoever calls it: validate the
 * input, authorize, then execute with the service-principal `db`.
 */
export async function runOperation<S extends z.ZodType, R>(
  operation: Operation<S, R>,
  call: { readonly actor: Actor | undefined; readonly input: unknown },
  db: DatabaseExports,
): Promise<R> {
  if (!isOperation(operation)) {
    throw new OperationError(500, "Operation failed");
  }
  const actor = call.actor;
  if (!actor?.userId) throw new OperationError(401, "Authentication required");
  const parsed = operation.input.safeParse(call.input);
  if (!parsed.success) {
    throw new OperationError(
      400,
      "Invalid input",
      parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    );
  }
  const run = async (client: TransactionClient) => {
    const context = { actor, input: parsed.data, db: client };
    await authorize(operation, context);
    return operation.execute(context);
  };
  if (operation.kind === "query") return run(db);

  return db.transaction(run);
}

/** The caller a safe response may describe, with no internal detail. */
export function operationErrorResponse(error: unknown): {
  status: number;
  body: { error: string; details?: readonly unknown[] };
} {
  if (isOperationError(error)) {
    return {
      status: error.statusCode,
      body: error.details
        ? { error: error.clientMessage, details: error.details }
        : { error: error.clientMessage },
    };
  }
  if (isValidationError(error)) {
    // Hook-authored issues, the same signal generated CRUD answers with 422.
    const details = error.issues
      .filter((issue) => issue.path.length > 0)
      .map((issue) => ({ path: issue.path.join("."), message: issue.message }));
    return {
      status: 422,
      body:
        details.length > 0
          ? { error: error.clientMessage, details }
          : { error: error.clientMessage },
    };
  }
  if (error instanceof DatabasePluginError) {
    return { status: error.statusCode, body: { error: error.clientMessage } };
  }
  logger.error("Operation failed: %s", describe(error));
  return { status: 500, body: { error: "Operation failed" } };
}

/**
 * The Apps proxy sets `x-forwarded-user` after authenticating the user; it is
 * the same header the rest of AppKit trusts. A body or query user id never is.
 */
export function resolveActor(req: Request): Actor | undefined {
  const userId = req.header("x-forwarded-user")?.trim();
  const userEmail = req.header("x-forwarded-email")?.trim() || undefined;
  if (userId) return { userId, userEmail };
  if (process.env.NODE_ENV === "development") return { userId: "dev-user" };
  return undefined;
}

const METHODS = ["get", "post", "put", "patch", "delete"] as const;
export type RouteMethod = (typeof METHODS)[number];

/** Parse `"POST /orders/:id/approve"`, failing setup on anything else. */
export function parseRouteKey(key: string): {
  method: RouteMethod;
  path: string;
} {
  const match = /^([A-Z]+) (\/[A-Za-z0-9_\-/:]*)$/.exec(key);
  const method = match?.[1].toLowerCase() as RouteMethod | undefined;
  if (!match || !method || !METHODS.includes(method)) {
    throw databaseSetupFailed(
      `Route ${JSON.stringify(key)} must look like "GET /orders" or "POST /orders/:id/approve".`,
    );
  }
  return { method, path: match[2] };
}

/**
 * Identity of a route for collision checks, matching Express's defaults:
 * parameter names, letter case, and a trailing slash do not tell routes apart.
 */
export function routeSignature(method: string, routePath: string): string {
  const path =
    routePath
      .replace(/:[^/]+/g, ":")
      .toLowerCase()
      .replace(/\/+$/, "") || "/";
  return `${method.toLowerCase()} ${path}`;
}

/** Same application-relative convention as `config/database/schema.ts`. */
const DEFAULT_ROUTES_DIR = "config/database/routes";

/**
 * Merge every `config/database/routes/*.ts` default export. A missing folder
 * means no routes; a repeated route in two files fails setup.
 */
export async function loadDefaultDatabaseRoutes(
  root = process.cwd(),
): Promise<DatabaseRoutes> {
  const dir = path.resolve(root, DEFAULT_ROUTES_DIR);
  let files: string[];
  try {
    files = (await readdir(dir)).filter((file) => /\.(ts|js|mjs)$/.test(file));
  } catch {
    return {};
  }
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url, { moduleCache: false });
  const routes: Record<string, AnyOperation> = {};
  for (const file of files.sort()) {
    const label = JSON.stringify(path.join(DEFAULT_ROUTES_DIR, file));
    let exported: unknown;
    try {
      exported = await jiti.import(path.join(dir, file), { default: true });
    } catch {
      // Import errors can contain credentials or application internals.
      throw databaseSetupFailed(`Could not load the routes module ${label}.`);
    }
    if (typeof exported !== "object" || exported === null) {
      throw databaseSetupFailed(
        `The routes module ${label} must default-export a { "METHOD /path": operation } record.`,
      );
    }
    for (const [key, operation] of Object.entries(exported)) {
      if (Object.hasOwn(routes, key)) {
        throw databaseSetupFailed(
          `Route ${JSON.stringify(key)} is declared more than once.`,
        );
      }
      routes[key] = operation;
    }
  }
  return routes;
}
