/** Postgres referential actions for FK `ON DELETE` / `ON UPDATE`. */
export type ReferentialAction =
  | "cascade"
  | "set null"
  | "set default"
  | "restrict"
  | "no action";

/**
 * A single foreign-key edge. The schema-builder produces these in both directions
 * (`fk()` declares the relation once); the introspector reads them from the catalog.
 */
export interface RelationEdge {
  /** Column on the owning table that holds the foreign key. */
  fromColumn: string;
  /** Target table name (unqualified). */
  toTable: string;
  /** Target column on the referenced table (usually its primary key). */
  toColumn: string;
  /** Referential action for `ON DELETE`. */
  onDelete?: ReferentialAction;
  /** Referential action for `ON UPDATE`. */
  onUpdate?: ReferentialAction;
}
