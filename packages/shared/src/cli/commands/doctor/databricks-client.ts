/**
 * The single seam where `appkit doctor` crosses into the Databricks SDK. The
 * SDK-free `shared` package reaches it via a runtime `import(...)`, degrading
 * gracefully when it's absent.
 */

/** Raised when `@databricks/sdk-experimental` is not resolvable at runtime. */
export class SdkNotInstalledError extends Error {
  constructor() {
    super(
      "The 'doctor' command requires the Databricks SDK (a dependency of @databricks/appkit). Please install @databricks/appkit to run connection checks.",
    );
    this.name = "SdkNotInstalledError";
  }
}

export interface ServiceClientHandle {
  /** WorkspaceClient, typed as unknown to keep `shared` SDK-free. */
  client: unknown;
}

function isModuleNotFound(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.message.includes("Cannot find module") ||
      err.message.includes("Cannot find package") ||
      (err as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND")
  );
}

/** Constructs a `WorkspaceClient` via the SDK's unified-auth chain. An explicit
 * `profile` is passed through `Config.profile` rather than mutating
 * `process.env`, so it doesn't leak beyond this call. */
export async function getServiceClient(
  profile?: string,
): Promise<ServiceClientHandle> {
  let sdk: { WorkspaceClient: new (opts: Record<string, unknown>) => unknown };
  try {
    sdk = (await import("@databricks/sdk-experimental")) as typeof sdk;
  } catch (err) {
    if (isModuleNotFound(err)) {
      throw new SdkNotInstalledError();
    }
    throw err;
  }

  const client = new sdk.WorkspaceClient(profile ? { profile } : {});
  return { client };
}

/** Raised when `@databricks/appkit` (needed for the Lakebase probe) is absent. */
export class AppkitNotInstalledError extends Error {
  constructor() {
    super(
      "The Lakebase connection check requires @databricks/appkit. Please install it to run this check.",
    );
    this.name = "AppkitNotInstalledError";
  }
}

/** Minimal `pg.Pool`-shaped handle. The caller owns it and must call `end()`. */
export interface LakebasePoolHandle {
  query: (sql: string) => Promise<unknown>;
  end: () => Promise<void>;
}

/** Builds a Lakebase pool via `createLakebasePool`. Connection settings
 * (`PGHOST`, `LAKEBASE_ENDPOINT`, …) come from the environment; we inject only
 * the resolved workspace client for OAuth token minting. */
export async function getLakebasePool(
  client: unknown,
): Promise<LakebasePoolHandle> {
  // A variable specifier stops TS from statically resolving `@databricks/appkit`,
  // an optional peer that `shared` has no dependency on.
  const appkitPkg = "@databricks/appkit";
  let appkit: {
    createLakebasePool: (cfg: Record<string, unknown>) => unknown;
  };
  try {
    appkit = await import(appkitPkg);
  } catch (err) {
    if (isModuleNotFound(err)) {
      throw new AppkitNotInstalledError();
    }
    throw err;
  }

  // Silence Lakebase's own logger. It defaults to an error-only console logger
  // that dumps the raw SDK ApiError (stack + full response blob) to stderr on a
  // failed token fetch. doctor classifies and prints that failure itself, so the
  // library's dump is just noise on top of our clean one-line report.
  const pool = appkit.createLakebasePool({
    workspaceClient: client,
    logger: { error: false },
  });
  return pool as unknown as LakebasePoolHandle;
}
