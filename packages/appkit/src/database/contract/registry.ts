/** The shape of a single generated registry entry. */
export interface DatabaseRegistryEntry {
  /** Full server-side row (includes private columns). */
  row: Record<string, unknown>;
  /** Default private-safe row returned by collection reads. */
  publicRow: Record<string, unknown>;
  /** Trusted insert payload (includes private fields; omits generated columns). */
  insert: Record<string, unknown>;
  /** Trusted update payload (includes private fields; omits PK/generated columns). */
  update: Record<string, unknown>;
  /** Per-column filter operators usable in `where`. */
  filters: Record<string, unknown>;
  /** Relations that can be passed to `include`. */
  includes: Record<string, unknown>;
  /** Literal capability used to omit keyed methods from keyless entities. */
  hasPrimaryKey: boolean;
}

/**
 * CANONICAL augmentation target. Empty by default; the generated `database.d.ts`
 * augments it via `declare module "@databricks/appkit" { interface DatabaseRegistry { ... } }`.
 */
// oxlint-disable-next-line typescript/no-empty-object-type -- augmentation target, populated by typegen.
export interface DatabaseRegistry {}

/** Literal entity keys present after typegen, or `never` before it has run. */
export type RegisteredEntity = keyof {
  [K in keyof DatabaseRegistry as string extends K ? never : K]: true;
};
