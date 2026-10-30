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

export type BranchMode = "dev" | "session";
export type SchemaStart = "migrate" | "introspect" | "clean" | "none";

export interface InitOptions {
  readonly mode?: BranchMode;
  readonly schema?: SchemaStart;
  /** As `--ttl` takes it: 30m, 1h, 7d. */
  readonly ttl?: string;
  readonly interactive?: boolean;
  readonly onStep?: (message: string) => void;
}

export interface CleanReport {
  readonly branch: string;
  readonly schemaName: string;
  readonly dependents: readonly string[];
}

export type InitStart =
  | { readonly kind: "none" }
  | { readonly kind: "migrate"; readonly migrate: MigrateReport }
  | { readonly kind: "introspect"; readonly introspect: IntrospectReport }
  | {
      readonly kind: "clean";
      readonly clean: CleanReport;
      readonly migrate: MigrateReport;
    };

export interface VerifyOptions {
  readonly deployed?: boolean;
  readonly target?: string;
}

export interface LocalVerifyReport {
  readonly kind: "local";
  readonly branch: string;
  readonly notYours: string | null;
  readonly refusesEveryBranch: boolean;
  readonly schemaProblems: readonly string[];
  readonly pendingMigrations: readonly string[];
  readonly strandedMigrations: readonly string[];
  readonly editedMigrations: readonly string[];
  readonly unknownMigrations: number;
  readonly ok: boolean;
}

export interface DeployVerifyReport {
  readonly kind: "deploy";
  readonly target: string;
  readonly host: string | null;
  readonly branch: string;
  readonly app: string | null;
  readonly migrations:
    | { readonly evidence: "verified" }
    | {
        readonly evidence: "differs";
        readonly missing: readonly string[];
        readonly changed: readonly string[];
        readonly unknown: readonly string[];
      }
    | { readonly evidence: "unavailable"; readonly reason: string }
    | null;
  readonly problems: readonly string[];
  readonly ok: boolean;
}

export type VerifyReport = LocalVerifyReport | DeployVerifyReport;

export interface CheckReport {
  readonly migrations: readonly string[];
  readonly problems: readonly string[];
  readonly ok: boolean;
}

export interface InitReport {
  readonly mode: BranchMode;
  readonly branch: string;
  readonly created: boolean;
  readonly sourceBranch?: string;
  readonly expireTime: string | null;
  readonly endpoint: string;
  readonly endpointCreated: boolean;
  readonly host: string;
  readonly database: string;
  readonly user: string;
  readonly role: {
    readonly name: string;
    readonly action: "kept" | "created" | "updated";
  };
  readonly handedOff: string | null;
  readonly envFile: string;
  readonly installed: string | null;
  readonly start: InitStart;
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
  readonly runInit: (ctx: Ctx, options?: InitOptions) => Promise<InitReport>;
  readonly previewClean: (ctx: Ctx) => Promise<CleanReport>;
  readonly runClean: (ctx: Ctx) => Promise<CleanReport>;
  readonly deleteSessionBranch: (
    ctx: Ctx,
  ) => Promise<{ readonly branch: string }>;
  readonly runSeed: (
    ctx: Ctx,
  ) => Promise<{ readonly branch: string; readonly file: string }>;
  readonly runVerify: (
    ctx: Ctx,
    options?: VerifyOptions,
  ) => Promise<VerifyReport>;
  readonly runCheck: (ctx: Ctx) => Promise<CheckReport>;
}
