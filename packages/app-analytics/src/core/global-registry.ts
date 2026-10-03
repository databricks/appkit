/**
 * Tab-wide state shared by every copy of this package on the page: a copy
 * bundled into another package, a separately loaded one, or a module
 * re-evaluated by HMR. Keys are registered symbols, so all copies agree on
 * them. Values are validated on read because another copy may have written
 * an incompatible shape.
 */
type Registry = Record<symbol, unknown>;

function registry(): Registry {
  return globalThis as unknown as Registry;
}

export function readGlobal(key: symbol): unknown {
  return registry()[key];
}

export function writeGlobal(key: symbol, value: unknown): void {
  registry()[key] = value;
}

export function deleteGlobal(key: symbol): void {
  Reflect.deleteProperty(registry(), key);
}

/** Returns the valid value under `key`, replacing a missing or foreign one. */
export function getOrCreateGlobal<T>(
  key: symbol,
  isValid: (value: unknown) => value is T,
  create: () => T,
): T {
  const existing = readGlobal(key);
  if (isValid(existing)) return existing;

  const created = create();
  writeGlobal(key, created);
  return created;
}
