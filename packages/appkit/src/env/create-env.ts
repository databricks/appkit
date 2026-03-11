import type { z } from "zod";
import { ConfigurationError } from "../errors";
import { throwEnvError } from "./errors";
import type { CreateEnvOptions, EnvValidationIssue } from "./types";

const DEFAULT_CLIENT_PREFIX = "VITE_";

/**
 * Detects whether code is running in a client (browser) context.
 */
function isClientContext(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    "document" in globalThis &&
    typeof process === "undefined"
  );
}

/**
 * Validates that all client schema keys start with the required prefix.
 * Throws at runtime if any key violates the prefix convention.
 */
function validateClientPrefix(clientKeys: string[], prefix: string): void {
  const invalid = clientKeys.filter((key) => !key.startsWith(prefix));

  if (invalid.length > 0) {
    throw new ConfigurationError(
      `Client environment variable keys must start with "${prefix}". ` +
        `Invalid keys: ${invalid.join(", ")}. ` +
        "Move non-prefixed variables to the server schema.",
      { context: { invalidKeys: invalid, requiredPrefix: prefix } },
    );
  }
}

/**
 * Extracts Zod issues into a flat list of EnvValidationIssue.
 */
function mapZodIssues(error: z.ZodError): EnvValidationIssue[] {
  return error.issues.map((issue) => ({
    key: issue.path.join(".") || "unknown",
    message: issue.message,
    received: (issue as unknown as Record<string, unknown>).received,
  }));
}

/**
 * Creates a type-safe, validated environment object.
 *
 * Validates environment variables against Zod schemas at runtime and returns
 * a frozen, fully-typed object. Enforces that client variables use the
 * configured prefix (default: `VITE_`) and prevents server variables from
 * being accessed in client (browser) contexts.
 *
 * @example
 * ```typescript
 * import { createEnv } from "@databricks/appkit";
 * import { z } from "zod";
 *
 * export const env = createEnv({
 *   server: z.object({
 *     DATABRICKS_HOST: z.string().url(),
 *     NODE_ENV: z.enum(["development", "production", "test"]).default("production"),
 *   }),
 *   client: z.object({
 *     VITE_APP_TITLE: z.string().default("My App"),
 *   }),
 * });
 *
 * env.DATABRICKS_HOST // string — typed and validated
 * env.VITE_APP_TITLE  // string — safe to use in client code
 * ```
 */
export function createEnv<
  TServer extends z.ZodRawShape,
  TClient extends z.ZodRawShape,
  TShared extends z.ZodRawShape = Record<string, never>,
>(
  options: CreateEnvOptions<TServer, TClient, TShared>,
): Readonly<
  z.infer<z.ZodObject<TServer>> &
    z.infer<z.ZodObject<TClient>> &
    z.infer<z.ZodObject<TShared>>
> {
  const {
    server,
    client,
    shared,
    clientPrefix = DEFAULT_CLIENT_PREFIX,
    skipValidation = false,
    onValidationError,
    onInvalidAccess,
  } = options;

  // Resolve the env source
  const runtimeEnv =
    options.runtimeEnv ??
    (typeof process !== "undefined" ? process.env : undefined) ??
    {};

  const serverKeys = new Set(Object.keys(server.shape));
  const clientKeys = Object.keys(client.shape);

  // Enforce client prefix at runtime
  validateClientPrefix(clientKeys, clientPrefix);

  // Merge all schemas
  const merged = shared
    ? server.merge(client as z.ZodObject<z.ZodRawShape>).merge(shared)
    : server.merge(client as z.ZodObject<z.ZodRawShape>);

  // Skip validation mode — return raw values
  if (skipValidation) {
    return runtimeEnv as never;
  }

  // Validate
  const result = merged.safeParse(runtimeEnv);

  if (!result.success) {
    const issues = mapZodIssues(result.error);

    if (onValidationError) {
      onValidationError(issues);
      // If the handler didn't throw, throw anyway
      throwEnvError(issues);
    }

    throwEnvError(issues);
  }

  const parsed = result.data as Record<string, unknown>;

  // Build a proxy that guards server vars in client contexts
  const proxy = new Proxy(parsed, {
    get(target, prop, receiver) {
      if (typeof prop !== "string") {
        return Reflect.get(target, prop, receiver);
      }

      if (serverKeys.has(prop) && isClientContext()) {
        if (onInvalidAccess) {
          onInvalidAccess(prop);
        }
        throw new ConfigurationError(
          `Server-only environment variable "${prop}" cannot be accessed in client code. ` +
            `Move it to the client or shared schema with a "${clientPrefix}" prefix.`,
          { context: { variable: prop } },
        );
      }

      return target[prop];
    },
  });

  return Object.freeze(proxy) as never;
}
