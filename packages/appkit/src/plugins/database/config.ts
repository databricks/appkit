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
  if ("pool" in config && config.pool !== undefined) {
    assertPoolConfig(config.pool);
  }
}

const POOL_KEYS = ["max", "idleTimeoutMillis", "connectionTimeoutMillis"];

/** Reject unknown keys and non-positive integers instead of passing them to pg. */
function assertPoolConfig(pool: unknown): void {
  if (typeof pool !== "object" || pool === null || Array.isArray(pool)) {
    throw databaseSetupFailed("pool must be an object.");
  }
  for (const [key, value] of Object.entries(pool)) {
    if (!POOL_KEYS.includes(key)) {
      throw databaseSetupFailed(
        `pool.${key} is not supported. Use ${POOL_KEYS.join(", ")}.`,
      );
    }
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || (value as number) < 1) {
      throw databaseSetupFailed(`pool.${key} must be a positive integer.`);
    }
  }
}
