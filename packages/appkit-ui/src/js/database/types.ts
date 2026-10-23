import type {
  DatabaseOperationMethod,
  DatabricksAppKitDatabaseOperations,
} from "shared";

type Operations = DatabricksAppKitDatabaseOperations;

/** Names of the generated database operations, or `never` before generation. */
export type DatabaseOperationName = Extract<keyof Operations, string>;

type NamesWithMethod<M extends DatabaseOperationMethod> = {
  [N in DatabaseOperationName]: Operations[N] extends { readonly method: M }
    ? N
    : never;
}[DatabaseOperationName];

/** GET operations, the names `useDatabaseQuery` reads. */
export type DatabaseQueryName = NamesWithMethod<"GET">;

/** POST, PATCH, PUT, and DELETE operations, the names `useDatabaseMutation` runs. */
export type DatabaseMutationName = NamesWithMethod<
  Exclude<DatabaseOperationMethod, "GET">
>;

/** The JSON input operation `N` accepts, as generation rendered it. */
export type DatabaseOperationInput<N extends DatabaseOperationName> =
  Operations[N] extends { readonly input: infer Input } ? Input : never;

/**
 * The JSON a successful call of `N` answers with, as generation rendered it.
 * `void` when the operation answers without a body.
 */
export type DatabaseOperationOutput<N extends DatabaseOperationName> =
  Operations[N] extends { readonly output: infer Output } ? Output : never;
