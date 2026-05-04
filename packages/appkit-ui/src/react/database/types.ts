import type {
  ColumnInfo,
  DatabaseEntityKey,
  DatabaseInsert,
  DatabaseRow,
  OrderInput,
  WhereInput,
} from "@/js";

export type { ColumnInfo };

/**
 * Visual variant for the entity browser. Only `"table"` is shipped today;
 * the union exists so future `"cards"`, `"grid"`, or `"inline"` variants
 * can land without breaking the public API.
 */
export type ViewEntityVariant = "table";

/**
 * Visual variant for the entity edit/create surfaces. Only `"modal"`
 * (shadcn Dialog) is shipped today; `"drawer"`, `"sheet"`, or `"inline"`
 * are reserved.
 */
export type EditEntityVariant = "modal";
export type CreateEntityVariant = "modal";

/** Row type for entity `E`, with fallback for entities not yet in the registry. */
export type RowOf<E extends DatabaseEntityKey> = DatabaseRow<E> extends never
  ? Record<string, unknown>
  : DatabaseRow<E>;

export interface ViewEntityProps<E extends DatabaseEntityKey> {
  /** Entity name — keys of the generated `DatabaseRegistry`. */
  entity: E;
  /** Visual style. Defaults to `"table"`. */
  variant?: ViewEntityVariant;
  /** Optional filter predicate. Same shape as `db.<entity>.where(...)`. */
  where?: WhereInput<RowOf<E>>;
  /** Optional sort directive. */
  order?: OrderInput<RowOf<E>>;
  /** Maximum number of rows fetched. Defaults to 50. */
  limit?: number;
  /**
   * Optional column projection passed to `db.<entity>.select(...)`.
   * Column names must exist on the entity; unknown names are ignored server-side.
   */
  select?: readonly string[];
  /** Optional column allow-list for table headers/cells (display order). */
  fields?: readonly string[];
  /** Accessibility label. */
  ariaLabel?: string;
  /** Test id hook. */
  testId?: string;
  /** Extra class applied to the wrapper. */
  className?: string;
  /**
   * When set, clicking a row invokes this with the row object (read-only
   * browsing). Useful for opening `<EditEntity>` from a parent.
   */
  onRowClick?: (row: RowOf<E>) => void;
}

/**
 * Shared shape for the entity mutation dialogs (`EditEntity` /
 * `CreateEntity`). Pulled into a base so the two surfaces stay aligned —
 * adding a knob in one place picks it up everywhere with no copy-paste.
 */
export interface EntityMutationDialogProps<E extends DatabaseEntityKey> {
  entity: E;
  /** Controlled open state. */
  open: boolean;
  /** Called when the user closes, cancels, or the submit completes. */
  onOpenChange: (open: boolean) => void;
  /** Called with the row produced by the underlying mutation. */
  onSuccess?: (row: RowOf<E>) => void;
  /** Render only these columns; others are hidden from the form. */
  fields?: readonly string[];
  /** Dialog title override. */
  title?: string;
  /** Dialog description override. */
  description?: string;
  /** Test id hook. */
  testId?: string;
}

export interface EditEntityProps<E extends DatabaseEntityKey>
  extends EntityMutationDialogProps<E> {
  /** Primary-key value of the row to edit. */
  id: string | number;
  /** Visual style. Defaults to `"modal"`. */
  variant?: EditEntityVariant;
}

export interface CreateEntityProps<E extends DatabaseEntityKey>
  extends EntityMutationDialogProps<E> {
  /** Visual style. Defaults to `"modal"`. */
  variant?: CreateEntityVariant;
  /** Default values for the form inputs. */
  defaults?: Partial<DatabaseInsert<E>>;
}
