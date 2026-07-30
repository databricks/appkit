/**
 * The single seam where `appkit doctor` crosses into the Databricks SDK.
 *
 * The CLI lives in the SDK-free `shared` package, so it reaches the SDK via a
 * runtime `import(...)` — keeping `shared` free of the dependency and degrading
 * gracefully when it's absent. All Databricks-touching check code goes through
 * this module; nothing else in the doctor command imports the SDK.
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

/** Env var the Databricks SDK's unified auth reads to select a CLI profile. */
const CONFIG_PROFILE_ENV = "DATABRICKS_CONFIG_PROFILE";

/** Constructs a `WorkspaceClient` via the SDK's unified-auth chain. `profile`
 * is applied through the env var the SDK reads. */
export async function getServiceClient(
  profile?: string,
): Promise<ServiceClientHandle> {
  if (profile) {
    // Deliberate, unrestored mutation: the SDK's unified auth reads the profile
    // from this env var, and there's no per-call config seam for it. Safe here
    // because doctor is a one-shot CLI that exits after a single run — this is
    // not a long-lived process where a lingering profile could leak between
    // operations.
    process.env[CONFIG_PROFILE_ENV] = profile;
  }

  // Narrowed to the one call we make; `shared` has no static SDK dependency.
  let sdk: { WorkspaceClient: new (opts: Record<string, unknown>) => unknown };
  try {
    sdk = (await import("@databricks/sdk-experimental")) as typeof sdk;
  } catch (err) {
    if (isModuleNotFound(err)) {
      throw new SdkNotInstalledError();
    }
    throw err;
  }

  const client = new sdk.WorkspaceClient({});
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
  // which `shared` has no dependency on; it's an optional peer resolved at runtime.
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

  const pool = appkit.createLakebasePool({ workspaceClient: client });
  return pool as unknown as LakebasePoolHandle;
}
