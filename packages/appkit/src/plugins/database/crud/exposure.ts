import { databaseSetupFailed } from "../../../database/errors";
import type { CrudWriteOperation } from "../types";

/** A table name also becomes a URL path segment, so keep it unambiguous. */
const ROUTABLE_TABLE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const WRITE_OPERATIONS: readonly CrudWriteOperation[] = [
  "create",
  "update",
  "delete",
];

/** Resolved generated routes for one plugin instance. */
export interface CrudExposure {
  readonly tables: readonly string[];
  readonly writes: ReadonlyMap<string, ReadonlySet<CrudWriteOperation>>;
}

/** Refuse names that cannot address exactly one table over HTTP. */
function assertRoutable(names: readonly string[]): void {
  const lowercased = new Set<string>();
  for (const name of names) {
    // Express matches paths case-insensitively, so near-duplicates would alias.
    if (!ROUTABLE_TABLE.test(name) || lowercased.has(name.toLowerCase())) {
      throw databaseSetupFailed();
    }
    lowercased.add(name.toLowerCase());
  }
}

/** Validate a unique list drawn from an allowlist. */
function requestedNames(value: unknown, allowed: readonly string[]): string[] {
  if (!Array.isArray(value)) throw databaseSetupFailed();
  const names: string[] = [];
  for (const name of value) {
    if (
      typeof name !== "string" ||
      !allowed.includes(name) ||
      names.includes(name)
    ) {
      throw databaseSetupFailed();
    }
    names.push(name);
  }
  return names;
}

/** Resolve and validate the generated HTTP routes selected by configuration. */
export function resolveCrudExposure(
  exposure: unknown,
  declared: readonly string[],
): CrudExposure {
  if (exposure === undefined || exposure === false) {
    return { tables: [], writes: new Map() };
  }

  let tables: string[];
  let writeConfig: unknown;
  if (exposure === true) {
    tables = [...declared];
  } else {
    if (typeof exposure !== "object" || exposure === null) {
      throw databaseSetupFailed();
    }
    const configured = exposure as { tables?: unknown; writes?: unknown };
    tables = requestedNames(configured.tables, declared);
    writeConfig = configured.writes;
  }
  assertRoutable(tables);

  const writes = new Map<string, ReadonlySet<CrudWriteOperation>>();
  if (writeConfig === undefined) return { tables, writes };

  let writeTables: string[];
  let operations: CrudWriteOperation[];
  if (writeConfig === true) {
    writeTables = tables;
    operations = [...WRITE_OPERATIONS];
  } else {
    if (typeof writeConfig !== "object" || writeConfig === null) {
      throw databaseSetupFailed();
    }
    const configured = writeConfig as {
      tables?: unknown;
      operations?: unknown;
    };
    writeTables =
      configured.tables === undefined
        ? tables
        : requestedNames(configured.tables, tables);
    operations = requestedNames(
      configured.operations,
      WRITE_OPERATIONS,
    ) as CrudWriteOperation[];
  }

  const enabled = new Set(operations);
  for (const table of writeTables) writes.set(table, enabled);
  return { tables, writes };
}
