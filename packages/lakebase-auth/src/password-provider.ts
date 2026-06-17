import type { WorkspaceClient } from "@databricks/sdk-experimental";
import {
  type CachedTokenProvider,
  cachedWithOnDemandRefresh,
  cachedWithTimedRefresh,
} from "./caching";
import { getWorkspaceClient } from "./config";
import { generateDatabaseCredential } from "./credentials";
import { ConfigurationError } from "./errors";
import { withRetries } from "./retry";
import type {
  Credential,
  FetchCredential,
  LakebaseAuthConfig,
  LogFn,
  RefreshMode,
  RequestedClaims,
  RetryOptions,
} from "./types";

/** Default early-refresh buffer: refresh ~2 minutes before the 1-hour expiry. */
export const DEFAULT_EARLY_REFRESH_MS = 2 * 60 * 1000;

/**
 * An async password callback paired with a disposer.
 *
 * `password` is the function to hand to a Postgres driver (`pg`, `postgres.js`,
 * `Bun.SQL`, ...) as the connection password. `dispose` stops any background
 * refresh timer and should be called when the connection/pool is closed.
 */
export interface PasswordProvider {
  /** Async callback returning a valid OAuth token to use as the password. */
  password: () => Promise<string>;
  /** Release background refresh timers (idempotent). Call on shutdown. */
  dispose: () => void;
}

/**
 * Options for {@link createPasswordProvider}.
 */
export interface CreatePasswordProviderOptions {
  /**
   * Custom credential fetcher. When omitted, a default fetcher is built from
   * `endpoint` + `workspaceClient`/`userConfig` using the Databricks SDK. This
   * is the seam consumers use to wrap credential generation with telemetry.
   */
  fetchCredential?: FetchCredential;

  /** Endpoint resource path (required when `fetchCredential` is not provided). */
  endpoint?: string;

  /** Workspace client used by the default fetcher (created lazily if omitted). */
  workspaceClient?: WorkspaceClient;

  /** Config passed to {@link getWorkspaceClient} by the default fetcher. */
  userConfig?: Partial<LakebaseAuthConfig>;

  /** Optional UC claims for the default fetcher. */
  claims?: RequestedClaims[];

  /** Refresh strategy. @default "eager" */
  mode?: RefreshMode;

  /** How long before expiry to refresh (ms). @default 120000 */
  earlyRefreshMs?: number;

  /** Retry options for credential fetches. */
  retry?: RetryOptions;

  /** Optional structured logging callback. */
  onLog?: LogFn;
}

/** Build the default SDK-based credential fetcher. */
function defaultFetchCredential(
  opts: CreatePasswordProviderOptions,
): FetchCredential {
  const { endpoint } = opts;
  if (!endpoint) {
    throw ConfigurationError.missingEnvVar(
      "config.endpoint (required to generate OAuth credentials)",
    );
  }

  // Lazily initialize the workspace client on first fetch.
  let workspaceClient: WorkspaceClient | null = opts.workspaceClient ?? null;

  return async (): Promise<Credential> => {
    if (!workspaceClient) {
      workspaceClient = getWorkspaceClient(opts.userConfig ?? {});
    }
    const credential = await generateDatabaseCredential(workspaceClient, {
      endpoint,
      ...(opts.claims ? { claims: opts.claims } : {}),
    });
    return {
      token: credential.token,
      expiresAt: new Date(credential.expire_time).getTime(),
    };
  };
}

/**
 * Create an OAuth password provider for Lakebase Postgres connections.
 *
 * The returned `password` callback fetches, caches, and refreshes a Lakebase
 * OAuth token, ready to use as the password for any Postgres driver. Refresh
 * is eager by default (token kept warm in the background) and retries
 * transient failures.
 *
 * @example pg
 * ```typescript
 * const { password, dispose } = createPasswordProvider({ endpoint });
 * const pool = new pg.Pool({ host, user, database, password });
 * // on shutdown: await pool.end(); dispose();
 * ```
 *
 * @example postgres.js
 * ```typescript
 * const { password } = createPasswordProvider({ endpoint });
 * const sql = postgres({ host, username, database, password });
 * ```
 *
 * @example Bun.SQL
 * ```typescript
 * const { password } = createPasswordProvider({ endpoint });
 * const sql = new Bun.SQL({ hostname: host, username, database, password });
 * ```
 */
export function createPasswordProvider(
  opts: CreatePasswordProviderOptions,
): PasswordProvider {
  const earlyRefreshMs = opts.earlyRefreshMs ?? DEFAULT_EARLY_REFRESH_MS;
  const mode: RefreshMode = opts.mode ?? "eager";

  const baseFetch = opts.fetchCredential ?? defaultFetchCredential(opts);
  const fetchWithRetries = withRetries(
    baseFetch,
    opts.retry?.schedule,
    opts.onLog,
  );

  const cache: CachedTokenProvider =
    mode === "eager"
      ? cachedWithTimedRefresh(fetchWithRetries, earlyRefreshMs, opts.onLog)
      : cachedWithOnDemandRefresh(fetchWithRetries, earlyRefreshMs);

  return {
    password: () => cache.getToken(),
    dispose: () => cache.dispose(),
  };
}
