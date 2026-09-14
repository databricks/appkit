import { databaseSetupFailed } from "../../database/errors";

/** Reject invalid arguments instead of turning them into the default API. */
export function assertDatabaseConfig(config: unknown): void {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw databaseSetupFailed(
      "Expected a database configuration object or no argument.",
    );
  }
  const prototype = Object.getPrototypeOf(config);
  if (prototype !== Object.prototype && prototype !== null) {
    throw databaseSetupFailed(
      "Expected a plain database configuration object.",
    );
  }
  // Do not silently turn a previous opt-out into the default full API.
  if ("crudRoutes" in config) {
    throw databaseSetupFailed(
      '"crudRoutes" was renamed to "api". Use api: false to disable generated routes or api: { writes: false } for reads only.',
    );
  }
}
