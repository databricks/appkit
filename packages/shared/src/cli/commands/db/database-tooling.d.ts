/**
 * Intentionally narrowed mirror of `@databricks/appkit/database-tooling`.
 *
 * `shared` is a leaf package and must not statically depend on `appkit`, so the
 * CLI loads the tooling via a dynamic `import(...)` and this declares its shape
 * without a build-time dependency (same pattern as ../type-generator.d.ts).
 * There is NO compile-time link to the real exports — if they change, re-sync
 * this by hand against `packages/appkit/src/database/tooling/index.ts`.
 */
declare module "@databricks/appkit/database-tooling" {
  export interface DbContext {
    readonly root: string;
    readonly env: NodeJS.ProcessEnv;
  }

  export function createDbContext(options?: {
    root?: string;
    env?: NodeJS.ProcessEnv;
  }): DbContext;

  export interface GeneratedMigration {
    readonly tag: string;
    readonly file: string;
    readonly statements: readonly string[];
  }

  export interface MigrateReport {
    readonly generated: GeneratedMigration | null;
    readonly applied: readonly string[];
    readonly adopted?: readonly string[];
    readonly notApplied?: string;
    readonly typesFile: string;
  }

  export function runMigrate(
    ctx: DbContext,
    options: { interactive: boolean },
  ): Promise<MigrateReport>;
}
