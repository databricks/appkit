import type { ColumnMeta } from "../../../database/schema-builder";
import { filterOperatorsForKind } from "../../../database/schema-builder/types";

/**
 * What one column may do over the generated HTTP routes. The route compiler
 * and the type generator both read these, so the typed browser surface cannot
 * drift from what the server actually accepts.
 */
export interface ColumnHttpCapabilities {
  /** A request may project it; every non-private column. */
  readonly selectable: boolean;
  /** A request may filter or order by it; its kind has an operator matrix. */
  readonly queryable: boolean;
  /** A create body may set it, including a caller-chosen key. */
  readonly creatable: boolean;
  /** An update body may set it; a key or a stamp is never one. */
  readonly updatable: boolean;
  /** It can address one row in `/:table/:id`. */
  readonly publicKey: boolean;
}

/** Derive one column's HTTP capabilities from its finalized metadata. */
export function columnHttpCapabilities(
  meta: ColumnMeta,
): ColumnHttpCapabilities {
  const selectable = !meta.isPrivate;
  // Database-generated identities belong to the server, never the caller.
  const creatable =
    selectable &&
    !meta.serverGenerated &&
    !(meta.primaryKey && meta.defaultRandom);
  return {
    selectable,
    queryable: selectable && filterOperatorsForKind(meta.kind).length > 0,
    creatable,
    // Rewriting a key would move a row out from under every existing reference,
    // and rewriting a database-materialized stamp would rewrite history.
    updatable:
      creatable && !meta.primaryKey && !meta.defaultNow && !meta.defaultRandom,
    // A private key must not power `GET /:table/:id`: per-id probing would
    // answer 200 or 404 on an identifier the schema hides, so over HTTP the
    // table is keyless — no detail route, and lists must name their own order.
    publicKey: meta.primaryKey && selectable,
  };
}
