/** What the CLI reads from a tooling context; the rest belongs to the tooling. */
export interface DbContext {
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface GeneratedMigration {
  readonly tag: string;
  readonly file: string;
  readonly statements: readonly string[];
}

export interface MigrateReport {
  readonly generated: GeneratedMigration | null;
  readonly applied: readonly string[];
  readonly adopted?: readonly string[];
  readonly breaking?: readonly string[];
  readonly notApplied?: string;
  readonly typesFile: string;
}

export interface Skip {
  readonly table: string;
  readonly column?: string;
  readonly reason: string;
}

export interface IntrospectReport {
  readonly branch: string;
  readonly schemaName: string;
  readonly tables: readonly string[];
  readonly schemaFile: string;
  readonly backupFile: string | null;
  readonly skipped: readonly Skip[];
  readonly warnings: readonly string[];
  readonly approximated: readonly string[];
  readonly migration: GeneratedMigration | null;
  readonly recorded: readonly string[];
  readonly typesFile: string;
}

/**
 * The exports of `@databricks/appkit/beta/database-tooling` the CLI calls. `shared`
 * must not depend on appkit, so the CLI imports the tooling dynamically and
 * types it with this interface, and appkit's typecheck checks its real exports
 * against it (`database/tooling/tests/contract.test.ts`). Function properties,
 * not methods, so a parameter narrowed in appkit fails that check.
 */
export interface DatabaseTooling<Ctx extends DbContext = DbContext> {
  readonly createDbContext: (options?: {
    root?: string;
    env?: NodeJS.ProcessEnv;
  }) => Ctx;
  readonly runMigrate: (
    ctx: Ctx,
    options: { interactive: boolean },
  ) => Promise<MigrateReport>;
  readonly runIntrospect: (
    ctx: Ctx,
    options: { interactive: boolean; schemaName?: string },
  ) => Promise<IntrospectReport>;
}
