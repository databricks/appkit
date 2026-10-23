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
  const prototype = Object.getPrototypeOf(config);
  if (prototype !== Object.prototype && prototype !== null) {
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
}
