import { databaseSetupFailed } from "../../../database/errors";

/** A table name also becomes a URL path segment, so keep it unambiguous. */
const ROUTABLE_TABLE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

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

/**
 * Resolve the tables whose generated reads are explicitly turned on. The
 * exposure value arrives untyped because a finalized schema widens its table
 * names to `string`, so every name is re-checked against the declared schema.
 */
export function resolveExposedTables(
  exposure: unknown,
  declared: readonly string[],
): string[] {
  if (exposure === undefined || exposure === false) return [];
  if (exposure === true) {
    assertRoutable(declared);
    return [...declared];
  }
  if (typeof exposure !== "object" || exposure === null) {
    throw databaseSetupFailed();
  }
  const requested = (exposure as { tables?: unknown }).tables;
  if (!Array.isArray(requested)) throw databaseSetupFailed();

  const names: string[] = [];
  for (const name of requested) {
    // Unknown and duplicate names are configuration bugs, not empty routes.
    if (typeof name !== "string" || !declared.includes(name)) {
      throw databaseSetupFailed();
    }
    if (names.includes(name)) throw databaseSetupFailed();
    names.push(name);
  }
  assertRoutable(names);
  return names;
}
