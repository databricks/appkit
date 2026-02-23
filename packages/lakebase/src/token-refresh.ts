import type { WorkspaceClient } from "@databricks/sdk-experimental";
import { getWorkspaceClient } from "./config";
import { generateDatabaseCredential } from "./credentials";
import { type DriverTelemetry, SpanStatusCode } from "./telemetry";
import type { LakebasePoolConfig, Logger } from "./types";

// 2-minute buffer before token expiration to prevent race conditions
// Lakebase tokens expire after 1 hour, so we refresh when ~58 minutes remain
const CACHE_BUFFER_MS = 2 * 60 * 1000;

export interface TokenRefreshDeps {
  userConfig: Partial<LakebasePoolConfig>;
  endpoint: string;
  telemetry: DriverTelemetry;
  logger?: Logger;
}

/** Fetch a fresh OAuth token from Databricks */
async function refreshToken(
  workspaceClient: WorkspaceClient,
  endpoint: string,
): Promise<{ token: string; expiresAt: number }> {
  const credential = await generateDatabaseCredential(workspaceClient, {
    endpoint,
  });

  return {
    token: credential.token,
    expiresAt: new Date(credential.expire_time).getTime(),
  };
}

/**
 * Build the password callback with token caching, deduplication, and telemetry.
 *
 * The returned async function is called by `pg.Pool` each time a new connection
 * is established. It caches OAuth tokens and deduplicates concurrent refresh
 * requests so only one API call is made even under parallel connection creation.
 */
export function createTokenRefreshCallback(
  deps: TokenRefreshDeps,
): () => Promise<string> {
  let cachedToken: string | undefined;
  let tokenExpiresAt = 0;
  let workspaceClient: WorkspaceClient | null = null;
  let refreshPromise: Promise<string> | null = null;

  return async (): Promise<string> => {
    // Lazily initialize workspace client on first password fetch
    if (!workspaceClient) {
      try {
        workspaceClient = getWorkspaceClient(deps.userConfig);
      } catch (error) {
        deps.logger?.error("Failed to initialize workspace client: %O", error);
        throw error;
      }
    }

    const now = Date.now();
    const hasValidToken = cachedToken && now < tokenExpiresAt - CACHE_BUFFER_MS;
    if (hasValidToken) {
      // Return cached token if still valid (with buffer)
      const expiresIn = Math.round((tokenExpiresAt - now) / 1000 / 60);
      deps.logger?.debug(
        "Using cached OAuth token (expires in %d minutes at %s)",
        expiresIn,
        new Date(tokenExpiresAt).toISOString(),
      );
      return cachedToken as string;
    }

    const client = workspaceClient;

    // Deduplicate concurrent refresh requests
    if (!refreshPromise) {
      refreshPromise = (async () => {
        const startTime = Date.now();
        try {
          const result = await deps.telemetry.tracer.startActiveSpan(
            "lakebase.token.refresh",
            {
              attributes: { "lakebase.endpoint": deps.endpoint },
            },
            async (span) => {
              const tokenResult = await refreshToken(client, deps.endpoint);
              span.setAttribute(
                "lakebase.token.expires_at",
                new Date(tokenResult.expiresAt).toISOString(),
              );
              span.setStatus({ code: SpanStatusCode.OK });
              span.end();
              return tokenResult;
            },
          );

          cachedToken = result.token;
          tokenExpiresAt = result.expiresAt;
          return cachedToken;
        } catch (error) {
          deps.logger?.error("Failed to fetch OAuth token: %O", {
            error,
            message: error instanceof Error ? error.message : String(error),
            endpoint: deps.endpoint,
          });
          throw error;
        } finally {
          deps.telemetry.tokenRefreshDuration.record(Date.now() - startTime);
          refreshPromise = null;
        }
      })();
    }

    return refreshPromise;
  };
}
