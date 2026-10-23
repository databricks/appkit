import { databaseSetupFailed } from "../../database/errors";

function isCallable(value: unknown): boolean {
  return typeof value === "function";
}

/** The shape of the generated `databaseRoutes` registry. */
function isDatabaseRoutes(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const modules: unknown = Reflect.get(value, "modules");
  return (
    isCallable(Reflect.get(value, "schema")) &&
    Array.isArray(modules) &&
    modules.every(
      (entry: unknown) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof Reflect.get(entry, "file") === "string" &&
        isCallable(Reflect.get(entry, "load")),
    )
  );
}

/** Reject invalid arguments instead of turning them into the default API. */
export function assertDatabaseConfig(config: unknown): void {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw databaseSetupFailed(
      "Expected a database configuration object or no argument.",
    );
  }
  if (!isPlainObject(config)) {
    throw databaseSetupFailed(
      "Expected a plain database configuration object.",
    );
  }
  const routes: unknown = Reflect.get(config, "routes");
  if (routes !== undefined && routes !== false && !isDatabaseRoutes(routes)) {
    throw databaseSetupFailed(
      "Expected routes to be the generated databaseRoutes registry, or false.",
    );
  }
  if ("pool" in config && config.pool !== undefined) {
    assertPoolConfig(config.pool);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Node turns a timer above this into 1 ms, so a longer timeout fires at once. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Allowed pool keys and the largest value each accepts. */
const POOL_KEY_LIMITS = new Map<string, number>([
  ["max", Number.MAX_SAFE_INTEGER],
  ["idleTimeoutMillis", MAX_TIMEOUT_MS],
  ["connectionTimeoutMillis", MAX_TIMEOUT_MS],
]);

/** Reject unknown keys and out-of-range values instead of passing them to pg. */
function assertPoolConfig(pool: unknown): void {
  if (!isPlainObject(pool)) {
    throw databaseSetupFailed("pool must be a plain object.");
  }
  for (const [key, value] of Object.entries(pool)) {
    const limit = POOL_KEY_LIMITS.get(key);
    if (limit === undefined) {
      throw databaseSetupFailed(
        `pool.${key} is not supported. Use ${[...POOL_KEY_LIMITS.keys()].join(", ")}.`,
      );
    }
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || (value as number) < 1) {
      throw databaseSetupFailed(`pool.${key} must be a positive integer.`);
    }
    if ((value as number) > limit) {
      throw databaseSetupFailed(`pool.${key} must be at most ${limit}.`);
    }
  }
}
