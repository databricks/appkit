/** HTTP methods a named database operation can answer. */
export type DatabaseOperationMethod =
  | "GET"
  | "POST"
  | "PATCH"
  | "PUT"
  | "DELETE";

/**
 * The browser-safe contract of one generated operation. `input` and `output`
 * are JSON types. A generated `database.d.ts` fills this interface by name.
 */
export interface DatabaseOperationContract {
  readonly method: DatabaseOperationMethod;
  readonly input: unknown;
  readonly output: unknown;
}

/**
 * Names the UI resolves without importing a server module. Empty until
 * generation adds one entry per operation name. The declaration is global so
 * a generated `database.d.ts` can augment it without importing this module.
 */
declare global {
  // oxlint-disable-next-line typescript/no-empty-object-type -- generated augmentation target.
  interface DatabricksAppKitDatabaseOperations {}
}

/** The same global registry, available as a module type for package exports. */
type GlobalDatabaseOperations = globalThis.DatabricksAppKitDatabaseOperations;
export type { GlobalDatabaseOperations as DatabricksAppKitDatabaseOperations };
