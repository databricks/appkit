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
import {
  newM2mCredentials,
  newPatCredentials,
} from "@databricks/sdk-auth/credentials";
import { type HttpClient, newFetchHttpClient } from "@databricks/sdk-core/http";
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
 * Map wrapper options onto the modular SDK's `ClientOptions`, reproducing the
 * legacy SDK's auth resolution: explicit token → PAT (the OBO path); profile →
 * profile file; otherwise the service principal from the environment. It carries
 * the privilege-escalation guard — check `token !== undefined` (NOT truthiness)
 * so an explicitly-passed token, even an empty string, pins the PAT path and
 * fails loudly at request time rather than silently falling through to the
 * service-principal env credentials (which would be an OBO privilege escalation).
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
    // Explicit token (this is the OBO path: `asUser` passes the user's token).
    clientOptions.credentials = newPatCredentials(opts.token);
  } else if (opts.profile) {
    clientOptions.profileOptions = { profile: opts.profile };
  } else {
    // No token, no profile: authenticate as the service principal from the
    // environment. The SDK's own default chain DOES read the DATABRICKS_* env
    // vars (host, client id/secret, token) — but its M2M strategy feeds the RAW
    // `DATABRICKS_HOST` straight into OAuth token-endpoint discovery, and the
    // Databricks Apps runtime sets that host scheme-less (e.g.
    // `x.cloud.databricks.com`), so discovery fails with `Invalid URL` and every
    // request dies as "Warehouse readiness check failed". Resolve the SP here
    // with the scheme-normalized `host` instead: M2M from client id + secret
    // (what Apps injects), else PAT from `DATABRICKS_TOKEN`, else fall through to
    // the SDK default chain (local dev, where a `~/.databrickscfg` host already
    // carries a scheme).
    const clientId = process.env.DATABRICKS_CLIENT_ID;
    const clientSecret = process.env.DATABRICKS_CLIENT_SECRET;
    const envToken = process.env.DATABRICKS_TOKEN;
    if (host && clientId && clientSecret) {
      clientOptions.credentials = newM2mCredentials({
        host,
        clientId,
        clientSecret,
      });
    } else if (envToken) {
      clientOptions.credentials = newPatCredentials(envToken);
    }
    // Otherwise leave credentials unset and let the SDK walk its profile-based
    // default chain (local dev with `~/.databrickscfg`).
  }
  const httpClient = buildHttpClient(opts);
  if (httpClient) {
    clientOptions.httpClient = httpClient;
  }
  return clientOptions;
}

/**
 * Wrap the SDK's default fetch transport to prepend AppKit's product segment to
 * the outgoing `User-Agent`, preserving the exact legacy string (e.g.
 * `@databricks/appkit/0.75.1`) that Databricks-side dashboards match on.
 *
 * Why the transport and not `setProduct`: the modular SDK's client-info API
 * validates the product as a simple token and rejects `@databricks/appkit` (the
 * `@`/`/`), and it is process-global. Setting the header on the `httpClient`
 * instead keeps the literal product name, is per-client, and — unlike a pnpm
 * patch — ships inside appkit's bundled `dist`, so it also reaches deployed apps
 * (npm-installed from the tarball, where pnpm patches do not apply). The SDK's
 * own client-info (`sdk-js-core/…`, runtime) is already on `request.headers`, so
 * prepending keeps it intact after AppKit's segment.
 *
 * Returns `undefined` when no product is configured (build-time callers), leaving
 * the SDK's default User-Agent untouched — matching the legacy behavior where
 * build-time clients carried no AppKit UA.
 */
function buildHttpClient(opts: WorkspaceClientOptions): HttpClient | undefined {
  const co = opts.clientOptions;
  if (!co?.product || !co?.productVersion) {
    return undefined;
  }
  const segments = [`${co.product}/${co.productVersion}`];
  if (co.userAgentExtra) {
    for (const [key, value] of Object.entries(co.userAgentExtra)) {
      segments.push(`${key}/${String(value)}`);
    }
  }
  const appkitUserAgent = segments.join(" ");
  const base = newFetchHttpClient();
  return {
    send(request) {
      const existing = request.headers.get("User-Agent");
      request.headers.set(
        "User-Agent",
        existing ? `${appkitUserAgent} ${existing}` : appkitUserAgent,
      );
      return base.send(request);
    },
  };
}

/** Build a modular Warehouses client from wrapper options. */
export function buildWarehousesClient(
  opts: WorkspaceClientOptions,
): WarehousesClient {
  return new WarehousesClient(mapToClientOptions(opts));
}

/** Build a modular Statement Execution client from wrapper options. */
export function buildStatementExecutionClient(
  opts: WorkspaceClientOptions,
): StatementExecutionClient {
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
