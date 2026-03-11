import type { z } from "zod";

/**
 * Ensures all keys in an object type start with the given prefix.
 * Used at the type level to enforce client variable naming conventions.
 */
export type EnsurePrefix<
  TPrefix extends string,
  TShape extends Record<string, unknown>,
> = {
  [K in keyof TShape]: K extends `${TPrefix}${string}` ? TShape[K] : never;
};

/**
 * Validates that all keys of TShape start with TPrefix.
 * Resolves to TShape if valid, `never` if any key violates the prefix.
 */
export type ValidateClientKeys<
  TPrefix extends string,
  TShape extends z.ZodRawShape,
> = keyof TShape extends `${TPrefix}${string}` ? TShape : never;

/**
 * A single validation issue for an environment variable.
 */
export interface EnvValidationIssue {
  /** The environment variable key */
  key: string;
  /** Human-readable error message */
  message: string;
  /** The received value (if any) */
  received?: unknown;
}

/**
 * Options for `createEnv()`.
 *
 * @typeParam TServer - Zod raw shape for server-only variables
 * @typeParam TClient - Zod raw shape for client variables (must use clientPrefix)
 * @typeParam TShared - Zod raw shape for variables accessible on both sides
 */
export interface CreateEnvOptions<
  TServer extends z.ZodRawShape = z.ZodRawShape,
  TClient extends z.ZodRawShape = z.ZodRawShape,
  TShared extends z.ZodRawShape = z.ZodRawShape,
> {
  /** Schema for server-only environment variables */
  server: z.ZodObject<TServer>;

  /** Schema for client environment variables (keys must start with clientPrefix) */
  client: z.ZodObject<ValidateClientKeys<string, TClient>>;

  /** Schema for variables accessible on both server and client */
  shared?: z.ZodObject<TShared>;

  /**
   * Explicit runtime env source. When provided, values are read from this
   * object instead of `process.env`.
   */
  runtimeEnv?: Record<string, string | undefined>;

  /**
   * Required prefix for client-side variables.
   * @default "VITE_"
   */
  clientPrefix?: string;

  /**
   * Skip validation entirely (useful for test environments).
   * Returns a passthrough object that reads raw values from the env source.
   */
  skipValidation?: boolean;

  /**
   * Custom handler called when validation fails.
   * If not provided, throws a `ConfigurationError`.
   */
  onValidationError?: (issues: EnvValidationIssue[]) => never | void;

  /**
   * Custom handler called when a server variable is accessed in a client context.
   * If not provided, throws an error.
   */
  onInvalidAccess?: (variable: string) => never | void;
}
