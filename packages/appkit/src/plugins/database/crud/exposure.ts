import { databaseSetupFailed } from "../../../database/errors";
import type { DatabaseApiWriteOperation } from "../types";

/** A table name also becomes a URL path segment, so keep it unambiguous. */
const ROUTABLE_TABLE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const WRITE_OPERATIONS: readonly DatabaseApiWriteOperation[] = [
  "create",
  "update",
  "delete",
];

/** Resolved generated routes for one plugin instance. */
export interface CrudExposure {
  readonly tables: readonly string[];
  readonly writes: ReadonlyMap<string, ReadonlySet<DatabaseApiWriteOperation>>;
}

/** Refuse names that cannot address exactly one table over HTTP. */
function assertRoutable(names: readonly string[]): void {
  const lowercased = new Map<string, string>();
  for (const name of names) {
    if (!ROUTABLE_TABLE.test(name)) {
      throw databaseSetupFailed(
        `Table ${JSON.stringify(name)} cannot be exposed through api. Route names must start with a letter, contain only letters, digits, "_", or "-", and be at most 64 characters. Rename the table, exclude it with api.tables, or set api: false.`,
      );
    }
    // Express matches paths case-insensitively, so near-duplicates would alias.
    const previous = lowercased.get(name.toLowerCase());
    if (previous !== undefined) {
      throw databaseSetupFailed(
        `Tables ${JSON.stringify(previous)} and ${JSON.stringify(name)} conflict in api because routes are case-insensitive. Rename a table, select only one with api.tables, or set api: false.`,
      );
    }
    lowercased.set(name.toLowerCase(), name);
  }
}

/** Validate a unique list drawn from an allowlist. */
function requestedNames(
  value: unknown,
  allowed: readonly string[],
  path: string,
): string[] {
  if (!Array.isArray(value)) {
    throw databaseSetupFailed(`${path} must be an array of names.`);
  }
  const names: string[] = [];
  for (const name of value) {
    if (typeof name !== "string") {
      throw databaseSetupFailed(`${path} must contain only string names.`);
    }
    if (!allowed.includes(name)) {
      throw databaseSetupFailed(
        `${path} contains unsupported name ${JSON.stringify(name)}. Allowed names: ${allowed.map((entry) => JSON.stringify(entry)).join(", ") || "none"}.`,
      );
    }
    if (names.includes(name)) {
      throw databaseSetupFailed(
        `${path} contains duplicate name ${JSON.stringify(name)}. List each name once.`,
      );
    }
    names.push(name);
  }
  return names;
}

/** Reject misspelled restrictions instead of silently enabling all routes. */
function configuration(
  value: unknown,
  allowedKeys: readonly string[],
  path: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw databaseSetupFailed(
      `${path} must be true, false, or a configuration object.`,
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw databaseSetupFailed(`${path} must be a plain configuration object.`);
  }
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      throw databaseSetupFailed(
        `Unknown option ${JSON.stringify(`${path}.${key}`)}. Allowed options: ${allowedKeys.join(", ")}.`,
      );
    }
  }
  return value as Record<string, unknown>;
}

/** Enable CRUD by default, applying only the restrictions the caller supplies. */
export function resolveCrudExposure(
  exposure: unknown,
  declared: readonly string[],
): CrudExposure {
  if (exposure === false) {
    return { tables: [], writes: new Map() };
  }

  let tables: string[];
  let writeConfig: unknown;
  if (exposure === undefined || exposure === true) {
    tables = [...declared];
  } else {
    const configured = configuration(exposure, ["tables", "writes"], "api");
    tables =
      configured.tables === undefined
        ? [...declared]
        : requestedNames(configured.tables, declared, "api.tables");
    writeConfig = configured.writes;
  }
  assertRoutable(tables);

  const writes = new Map<string, ReadonlySet<DatabaseApiWriteOperation>>();
  if (writeConfig === false) return { tables, writes };

  let writeTables: string[];
  let operations: DatabaseApiWriteOperation[];
  if (writeConfig === undefined || writeConfig === true) {
    writeTables = tables;
    operations = [...WRITE_OPERATIONS];
  } else {
    const configured = configuration(
      writeConfig,
      ["tables", "operations"],
      "api.writes",
    );
    writeTables =
      configured.tables === undefined
        ? tables
        : requestedNames(configured.tables, tables, "api.writes.tables");
    operations =
      configured.operations === undefined
        ? [...WRITE_OPERATIONS]
        : (requestedNames(
            configured.operations,
            WRITE_OPERATIONS,
            "api.writes.operations",
          ) as DatabaseApiWriteOperation[]);
  }

  const enabled = new Set(operations);
  for (const table of writeTables) writes.set(table, enabled);
  return { tables, writes };
}
