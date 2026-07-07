/** The shape of a single generated registry entry. */
export interface DatabaseRegistryEntry {
  /** Full server-side row (includes private columns). */
  row: Record<string, unknown>;
  /** Accepted insert payload (private + server-generated columns omitted). */
  insert: Record<string, unknown>;
  /** Accepted update payload (PK + private + server-generated omitted, all optional). */
  update: Record<string, unknown>;
  /** Per-column filter operators usable in `where`. */
  filters: Record<string, unknown>;
  /** Relations that can be passed to `include`. */
  includes: Record<string, unknown>;
}

/**
 * CANONICAL augmentation target. Empty by default; the generated `database.d.ts`
 * augments it via `declare module "@databricks/appkit" { interface DatabaseRegistry { ... } }`.
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmentation target, populated by typegen.
export interface DatabaseRegistry {}

/** Literal entity keys present after typegen, or `never` before it has run. */
export type RegisteredEntity = keyof {
  [K in keyof DatabaseRegistry as string extends K ? never : K]: true;
};
