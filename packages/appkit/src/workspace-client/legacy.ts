/**
 * Legacy `@databricks/sdk-experimental` `WorkspaceClient` construction,
 * isolated to one module so the rest of the wrapper can stay focused on the
 * modular SDK.
 *
 * The legacy client is used by:
 *   1. `AppKitWorkspaceClient` service getters that don't yet have a modular
 *      replacement (currentUser, statementExecution, servingEndpoints, genie,
 *      jobs).
 *   2. The `toLegacyWorkspaceClient()` escape hatch, used by callers that
 *      need to hand a client off to `@databricks/lakebase` (which is still
 *      on the old SDK).
 */
import {
  type ClientOptions as LegacyClientOptions,
  WorkspaceClient as LegacyWorkspaceClient,
} from "@databricks/sdk-experimental";

/**
 * Options used to construct the wrapper. Mirrors the subset of the old SDK's
 * `Config` + `ClientOptions` that AppKit relies on today; we explicitly do
 * NOT re-expose every old-SDK config knob.
 */
export interface WorkspaceClientOptions {
  /** Databricks host, e.g. https://my-workspace.cloud.databricks.com. Defaults to DATABRICKS_HOST. */
  host?: string;
  /** Bearer token. When set, `authType` is forced to "pat". */
  token?: string;
  /** Authentication strategy passed to the legacy client. */
  authType?: "pat";
  /** Product name used in the User-Agent (e.g. "@databricks/appkit"). */
  product: string;
  /** Product version (semver) used in the User-Agent. */
  productVersion: `${number}.${number}.${number}`;
  /** Additional User-Agent segments. */
  userAgentExtra?: Record<string, string>;
}

/** Convert wrapper options to the legacy SDK's `ClientOptions` shape. */
function toLegacyClientOptions(
  opts: WorkspaceClientOptions,
): LegacyClientOptions {
  return {
    product: opts.product,
    productVersion: opts.productVersion,
    ...(opts.userAgentExtra ? { userAgentExtra: opts.userAgentExtra } : {}),
  };
}

/**
 * Construct a legacy `WorkspaceClient` from wrapper options.
 *
 * Centralised so the wrapper, the `.toLegacyWorkspaceClient()` escape hatch,
 * and any per-request OBO client all build it the same way.
 */
export function buildLegacyWorkspaceClient(
  opts: WorkspaceClientOptions,
): LegacyWorkspaceClient {
  const cfg = opts.token
    ? { host: opts.host, token: opts.token, authType: opts.authType ?? "pat" }
    : {};
  return new LegacyWorkspaceClient(cfg, toLegacyClientOptions(opts));
}

export { LegacyWorkspaceClient };
