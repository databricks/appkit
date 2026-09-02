/**
 * The single module allowed to import the modular `@databricks/sdk-*` SDK
 * directly — the new-SDK sibling of {@link ./legacy.ts}. Every other AppKit
 * module reaches these clients through the {@link WorkspaceClient} facade and
 * the type re-exports below, so the modular SDK stays isolated exactly like the
 * legacy one (the oxlint `no-restricted-imports` boundary walls `@databricks/sdk-*`
 * off everywhere outside `packages/shared/src/workspace-client/`).
 *
 * Migrated services are built here as per-service clients; the facade delegates
 * their accessors to these instead of the legacy monolithic client. Currently
 * `warehouses` and `statementExecution` are migrated; every other service still
 * routes through `legacy.ts`.
 *
 * NOTE: statementExecution relies on a pinned pnpm patch
 * (`patches/@databricks__sdk-statementexecution@0.46.0.patch`) that restores the
 * undocumented Reyden `attachment` response field, which the SDK's generated
 * unmarshal transform would otherwise strip.
 */
import { newPatCredentials } from "@databricks/sdk-auth/credentials";
import { addToDefault, setProduct } from "@databricks/sdk-core/clientinfo";
import type { ClientOptions } from "@databricks/sdk-options/client";
import { StatementExecutionClient } from "@databricks/sdk-statementexecution/v1";
import { WarehousesClient } from "@databricks/sdk-warehouses/v1";

import type { WorkspaceClientOptions } from "./legacy";

/**
 * Prepend `https://` to a scheme-less host. The legacy SDK normalized the host
 * this way; the modular SDK does NOT — it passes the host straight into `fetch`,
 * so a bare `DATABRICKS_HOST=my-workspace.cloud.databricks.com` (the common form,
 * and what the Databricks Apps runtime sets) yields `TypeError: Invalid URL`.
 */
function normalizeHost(host: string | undefined): string | undefined {
  const trimmed = host?.trim();
  if (!trimmed) return undefined;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * Map wrapper options onto the modular SDK's `ClientOptions`. Mirrors
 * `buildLegacyWorkspaceClient`'s auth resolution verbatim, including the
 * privilege-escalation guard: check `token !== undefined` (NOT truthiness) so an
 * explicitly-passed token — even an empty string — pins the PAT path and fails
 * loudly at request time rather than silently authenticating as the service
 * principal via the default chain (which would be an OBO privilege escalation).
 */
function mapToClientOptions(opts: WorkspaceClientOptions): ClientOptions {
  const clientOptions: ClientOptions = {};
  // Resolve + scheme-normalize the host the way the legacy SDK did. Explicit
  // `opts.host` wins; otherwise fall back to `DATABRICKS_HOST` (env is where the
  // Apps runtime and dev set it). When a profile is selected without an explicit
  // host, defer to the SDK's profile-file resolution instead of the env.
  const host = normalizeHost(
    opts.host ?? (opts.profile ? undefined : process.env.DATABRICKS_HOST),
  );
  if (host) {
    clientOptions.host = host;
  }
  if (opts.token !== undefined) {
    clientOptions.credentials = newPatCredentials(opts.token);
  } else if (opts.profile) {
    clientOptions.profileOptions = { profile: opts.profile };
  }
  // Neither token nor profile → leave credentials unset so the SDK walks its
  // default auth chain (env vars + ~/.databrickscfg), matching the legacy `{}` case.
  return clientOptions;
}

// The modular SDK has no per-client User-Agent option; product/client-info is a
// process-global set once via `setProduct`/`addToDefault` before any client is
// built. The AppKit product/version/userAgentExtra arrive on `opts.clientOptions`
// (from `getClientOptions()`); build-time callers omit them and are left unstamped,
// preserving the legacy behavior where build-time clients carry no AppKit UA. The
// flag latches only once we actually stamp, so a first (unstamped) build-time
// client never blocks a later runtime client from stamping.
let clientInfoStamped = false;

/**
 * Coerce an arbitrary string into a valid client-info segment. The modular SDK
 * validates keys as simple tokens and throws `ClientInfoError` on anything else,
 * so the legacy product name `@databricks/appkit` (with `@` and `/`) is rejected
 * — collapse invalid runs to `-` and trim the ends (`@databricks/appkit` →
 * `databricks-appkit`).
 */
function toClientInfoKey(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function ensureClientInfo(opts: WorkspaceClientOptions): void {
  if (clientInfoStamped) {
    return;
  }
  const co = opts.clientOptions;
  if (!co?.product || !co?.productVersion) {
    return;
  }
  // User-Agent stamping is best-effort: a value the SDK's client-info validator
  // rejects must NEVER break client construction (the legacy SDK stamped the UA
  // without validating). On failure the outbound request just carries the SDK's
  // default User-Agent.
  try {
    setProduct(toClientInfoKey(co.product), co.productVersion);
    if (co.userAgentExtra) {
      for (const [key, value] of Object.entries(co.userAgentExtra)) {
        addToDefault(toClientInfoKey(key), String(value));
      }
    }
    clientInfoStamped = true;
  } catch {
    clientInfoStamped = true;
  }
}

/** Build a modular Warehouses client from wrapper options. */
export function buildWarehousesClient(
  opts: WorkspaceClientOptions,
): WarehousesClient {
  ensureClientInfo(opts);
  return new WarehousesClient(mapToClientOptions(opts));
}

/** Build a modular Statement Execution client from wrapper options. */
export function buildStatementExecutionClient(
  opts: WorkspaceClientOptions,
): StatementExecutionClient {
  ensureClientInfo(opts);
  return new StatementExecutionClient(mapToClientOptions(opts));
}

// ── Client type re-exports (for the facade accessor types) ───────────────
export type { StatementExecutionClient } from "@databricks/sdk-statementexecution/v1";
export type { WarehousesClient } from "@databricks/sdk-warehouses/v1";

// ── Model type re-exports ────────────────────────────────────────────────
// AppKit modules import request/response/enum types from the wrapper rather
// than the SDK, so the import boundary holds. Type-only: the connector compares
// state against string literals, which satisfy the SDK's `Enum | (string & {})`
// field unions — no runtime enum values needed.
export type {
  ColumnInfo,
  Disposition,
  ExecuteStatementRequest,
  ExternalLink,
  Format,
  ResultData,
  ResultManifest,
  Schema,
  ServiceError,
  StatementParameter,
  StatementResponse,
  StatementStatus,
  StatementStatus_State,
} from "@databricks/sdk-statementexecution/v1";
export type {
  EndpointHealth,
  EndpointInfo,
  EndpointState,
  GetWarehouseResponse,
} from "@databricks/sdk-warehouses/v1";
