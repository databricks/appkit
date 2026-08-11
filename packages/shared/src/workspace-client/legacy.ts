/**
 * The single module in AppKit allowed to import `@databricks/sdk-experimental`
 * directly (enforced by the Biome `noRestrictedImports` boundary rule). Every
 * other AppKit module reaches the SDK through the wrapper's re-exports and the
 * {@link WorkspaceClient} facade.
 *
 * Isolating the SDK here is what makes the incremental migration to the modular
 * Databricks SDK a localized change: to migrate a service, swap its getter in
 * `client.ts` from the legacy delegate to the modular client — nothing else in
 * the codebase imports the SDK, so the blast radius is one connector + its test.
 */

import type {
  ClientOptions,
  WorkspaceClient as SdkWorkspaceClient,
} from "@databricks/sdk-experimental";
import * as SDK from "@databricks/sdk-experimental";

const { WorkspaceClient: SdkWorkspaceClientCtor } = SDK;

/** The concrete legacy SDK client type. */
export type LegacyWorkspaceClient = SdkWorkspaceClient;

/**
 * Options used to construct the wrapper. Mirrors the subset of the old SDK's
 * `Config` + `ClientOptions` that AppKit relies on today; we deliberately do
 * NOT re-expose every old-SDK config knob.
 */
export interface WorkspaceClientOptions {
  /** Databricks host, e.g. https://my-workspace.cloud.databricks.com. Defaults to DATABRICKS_HOST / profile resolution. */
  host?: string;
  /** `~/.databrickscfg` profile name. Used when no host/token is provided. */
  profile?: string;
  /** Bearer token. When set, `authType` defaults to "pat". */
  token?: string;
  /** Authentication strategy passed to the legacy client. */
  authType?: "pat";
  /**
   * SDK client options (product / productVersion / userAgentExtra) used to
   * stamp the outbound User-Agent. Produced by `getClientOptions()`; omitted
   * by build-time callers that don't stamp a User-Agent.
   */
  clientOptions?: ClientOptions;
}

/**
 * Construct a legacy `WorkspaceClient` from wrapper options.
 *
 * Centralised so the wrapper facade, the `.toLegacyWorkspaceClient()` escape
 * hatch, and any per-request OBO client all build it the same way.
 */
export function buildLegacyWorkspaceClient(
  opts: WorkspaceClientOptions,
): LegacyWorkspaceClient {
  // Check `token !== undefined`, NOT truthiness: an explicitly-passed token
  // must stick to the PAT path even when it's an empty string. Falling through
  // to the default-auth branch on an empty OBO token would silently
  // authenticate as the service principal instead of failing — a privilege
  // escalation in the OBO path. An invalid/empty token should blow up loudly.
  const cfg =
    opts.token !== undefined
      ? { host: opts.host, token: opts.token, authType: opts.authType ?? "pat" }
      : opts.host
        ? { host: opts.host }
        : opts.profile
          ? { profile: opts.profile }
          : {};
  return new SdkWorkspaceClientCtor(cfg, opts.clientOptions);
}

// ── SDK type re-exports ──────────────────────────────────────────────
export type {
  CancellationToken,
  ClientOptions,
} from "@databricks/sdk-experimental";
// ── SDK value re-exports ─────────────────────────────────────────────
//
// AppKit modules import these from the wrapper instead of the SDK so the
// boundary rule holds. `Context` bridges AbortSignal → CancellationToken
// (serving/jobs/sql-warehouse); `Time`/`TimeUnits` drive genie polling;
// `ConfigError` is matched in service-context's auth-failure handling.
//
// These are sourced off the namespace import rather than `export { ... } from`
// because the SDK is CommonJS: its `Time` export is emitted as a getter that
// calls `__importDefault(...)`, which defeats Node's static named-export
// detection — a direct `export { Time }` throws "does not provide an export
// named 'Time'" at ESM link time. `Time` is only reachable via the module
// object, so we fall back to `SDK.default.Time` (matching the original genie
// connector's `SDK.Time ?? SDK.default.Time` guard).
export const { ConfigError, Context, TimeUnits, loadConfigFile } = SDK;
export const Time =
  SDK.Time ?? (SDK as unknown as { default: typeof SDK }).default.Time;

// Deep-import types used by the genie connector's waiter idiom. Not exposed
// on the SDK's top-level index, so re-exported here to keep the genie
// connector off a direct `@databricks/sdk-experimental/dist/**` import.
export type { GenieMessage } from "@databricks/sdk-experimental/dist/apis/dashboards";
export type { Waiter } from "@databricks/sdk-experimental/dist/wait";
