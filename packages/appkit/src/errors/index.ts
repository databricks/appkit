/**
 * AppKit Error Classes
 *
 * Standardized error classes for consistent error handling across the framework.
 *
 * @example
 * ```typescript
 * import { ValidationError, AuthenticationError } from "@databricks/appkit";
 *
 * // Validation errors
 * throw new ValidationError("Invalid parameter value");
 * throw ValidationError.missingField("warehouseId");
 *
 * // Authentication errors
 * throw AuthenticationError.missingToken();
 *
 * // Configuration errors
 * throw ConfigurationError.missingEnvVar("DATABRICKS_HOST");
 * ```
 */

export { AuthenticationError } from "./authentication";
export { AppKitError } from "./base";
export { ConfigurationError } from "./configuration";
export { ConnectionError } from "./connection";
export { ExecutionError } from "./execution";
export { InitializationError } from "./initialization";
export { ServerError } from "./server";
export { TunnelError } from "./tunnel";
export { ValidationError } from "./validation";
