import { WorkspaceClient } from "@databricks/sdk-experimental";

/** Resolved Databricks host + bearer token for the eval runner's REST calls. */
export interface DatabricksAuth {
  host: string;
  token: string;
}

export interface ResolveDatabricksAuthOptions {
  /** `~/.databrickscfg` profile to authenticate with (e.g. `dogfood`). */
  profile?: string;
  /** Explicit host; wins over the profile/SDK-resolved host when set. */
  host?: string;
  /** Explicit bearer token; when set, no OAuth is minted (PAT/CI path). */
  token?: string;
}

/**
 * Resolve `{host, token}` for the eval runner the same way the rest of AppKit
 * authenticates: construct a Databricks `WorkspaceClient` and let its config
 * mint (and later refresh) an OAuth bearer from the CLI profile — no hand-set
 * PAT required. An explicit host/token still wins (PAT or CI env), so the SDK
 * is only consulted for whatever isn't supplied.
 *
 * Returns `undefined` when neither an explicit token nor a resolvable profile
 * yields a bearer, so the caller can treat auth as simply unavailable.
 */
export async function resolveDatabricksAuth(
  options: ResolveDatabricksAuthOptions = {},
): Promise<DatabricksAuth | undefined> {
  // Fully explicit — no need to touch the SDK.
  if (options.host && options.token) {
    return { host: options.host, token: options.token };
  }

  try {
    const client = resolveWorkspaceClient(options);
    if (!client) return undefined;
    const headers = new Headers();
    // Mints the OAuth access token (or reuses a PAT from the profile) and adds
    // an `Authorization: Bearer <token>` header — the same call the connectors
    // use before each request.
    await client.config.authenticate(headers);
    const token =
      options.token ?? headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    const host =
      options.host ??
      (await client.config.getHost()).toString().replace(/\/+$/, "");
    if (!token || !host) return undefined;
    return { host, token };
  } catch {
    return undefined;
  }
}

/**
 * Construct a Databricks `WorkspaceClient` for the eval runner — the object the
 * SDK-backed connectors (e.g. `SQLWarehouseConnector`) take. An explicit
 * host+token builds a PAT client; otherwise the profile (or ambient config) is
 * used and the SDK resolves credentials, minting OAuth as needed. Returns
 * `undefined` if construction throws (missing/invalid config).
 */
export function resolveWorkspaceClient(
  options: ResolveDatabricksAuthOptions = {},
): WorkspaceClient | undefined {
  try {
    if (options.host && options.token) {
      return new WorkspaceClient({
        host: options.host,
        token: options.token,
        authType: "pat",
      });
    }
    return new WorkspaceClient(
      options.profile ? { profile: options.profile } : {},
    );
  } catch {
    return undefined;
  }
}
