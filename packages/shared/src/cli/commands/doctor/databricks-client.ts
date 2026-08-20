/**
 * The seam where `appkit doctor` crosses into the Databricks SDK. It reaches
 * the SDK through the shared `workspace-client` facade — the one sanctioned SDK
 * import site — so no dynamic import or `noRestrictedImports` suppression is
 * needed. (The Lakebase probe still dynamically imports `@databricks/appkit`
 * below, since that's an optional peer `shared` deliberately doesn't depend on.)
 */

import {
  createWorkspaceClient,
  loadConfigFile,
} from "../../../workspace-client";

/**
 * Retained for backward compatibility. Since `shared` now depends on the SDK
 * (reached via the workspace-client facade), the SDK is always resolvable at
 * runtime and this is no longer thrown; kept exported so existing callers and
 * the `SDK_NOT_INSTALLED` diagnostic branch keep compiling.
 */
export class SdkNotInstalledError extends Error {
  constructor() {
    super(
      "The 'doctor' command requires the Databricks SDK (a dependency of @databricks/appkit).",
    );
    this.name = "SdkNotInstalledError";
  }
}

interface ServiceClientHandle {
  /** WorkspaceClient, typed as unknown to keep doctor's call sites SDK-agnostic. */
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

/** Constructs a workspace client via the SDK's unified-auth chain. An explicit
 * `profile` is passed through `Config.profile` rather than mutating
 * `process.env`, so it doesn't leak beyond this call. */
export async function getServiceClient(
  profile?: string,
): Promise<ServiceClientHandle> {
  const client = createWorkspaceClient(
    profile ? { profile } : {},
  ).toLegacyWorkspaceClient();
  return { client };
}

/**
 * The host a named profile declares in `~/.databrickscfg`, read offline. Doctor
 * uses it to detect a profile/host conflict, so it must not depend on the
 * resolved config (where `DATABRICKS_HOST` has already won). Returns undefined
 * for any unreadable file, missing profile, or hostless profile — a conflict we
 * can't prove isn't worth reporting.
 */
export async function getProfileHost(
  profile: string,
): Promise<string | undefined> {
  try {
    const { iniFile } = await loadConfigFile(
      process.env.DATABRICKS_CONFIG_FILE,
    );
    const host = iniFile?.[profile]?.host;
    return typeof host === "string" && host.length > 0 ? host : undefined;
  } catch {
    return undefined;
  }
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
