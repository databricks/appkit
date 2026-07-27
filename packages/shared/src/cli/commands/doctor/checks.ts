/**
 * The `auth` and `config` layer checks. (The `existence` layer's per-type
 * probes live in `checks-existence.ts`.)
 */

import { runExistenceProbe } from "./checks-existence";
import { getServiceClient, SdkNotInstalledError } from "./databricks-client";
import type {
  AuthCheckResult,
  DoctorOptions,
  LayerResult,
  ResourceTarget,
} from "./types";

/** The auth result plus the resolved client (present only on success), which
 * the orchestrator hands to the live layers so they don't rebuild it. */
export interface AuthOutcome {
  result: AuthCheckResult;
  client?: unknown;
}

interface CurrentUserClient {
  currentUser: {
    me: () => Promise<{ id?: string; userName?: string }>;
  };
}

/**
 * Validates `DATABRICKS_HOST` before we hand it to the SDK, so an unfilled
 * placeholder (e.g. `https://...`) gets a clear message instead of the SDK's
 * opaque "cannot configure default credentials" error. Returns an error
 * message, or null when the host is acceptable or unset.
 */
export function validateHost(host: string | undefined): string | null {
  if (host === undefined || host.trim().length === 0) return null;

  let url: URL;
  try {
    url = new URL(host);
  } catch {
    return `DATABRICKS_HOST is not a valid URL: "${host}"`;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return `DATABRICKS_HOST must be an http(s) URL: "${host}"`;
  }

  // Placeholders like "https://..." parse as a URL but have a hostname with no
  // real (dotted, alphanumeric) label.
  const hostname = url.hostname;
  const hasRealLabel = /[a-z0-9]/i.test(hostname) && hostname.includes(".");
  if (!hasRealLabel || /^[.\-_]+$/.test(hostname)) {
    return `DATABRICKS_HOST looks like an unfilled placeholder: "${host}"`;
  }

  return null;
}

/**
 * Layer: auth. Runs once, app-wide; a failure short-circuits every resource's
 * existence check (they all need the client).
 */
export async function checkAuth(options: DoctorOptions): Promise<AuthOutcome> {
  const host = process.env.DATABRICKS_HOST;
  const hostError = validateHost(host);
  if (hostError) {
    return {
      result: {
        status: "error",
        code: "HOST_INVALID",
        detail: hostError,
        host,
        profile: options.profile,
      },
    };
  }

  try {
    const { client } = await getServiceClient(options.profile);
    const me = await (client as CurrentUserClient).currentUser.me();
    const who = me.userName ?? me.id ?? "unknown";

    return {
      client,
      result: {
        status: "ok",
        code: "AUTH_OK",
        detail: `authenticated as ${who}`,
        host,
        profile: options.profile,
      },
    };
  } catch (err) {
    if (err instanceof SdkNotInstalledError) {
      return {
        result: {
          status: "error",
          code: "SDK_NOT_INSTALLED",
          detail: err.message,
          profile: options.profile,
        },
      };
    }
    const detail = err instanceof Error ? err.message : String(err);
    return {
      result: {
        status: "error",
        code: "AUTH_FAILED",
        detail: `failed to authenticate to the workspace: ${detail}`,
        hint: authFailureHint(detail, options.profile),
        host,
        profile: options.profile,
      },
    };
  }
}

/**
 * Infers guidance for common auth failures, which the SDK surfaces as opaque
 * strings. Patterns are matched most specific first; returns the fixing command
 * or undefined for an unrecognized failure.
 */
function authFailureHint(
  message: string,
  profile?: string,
): string | undefined {
  const loginCmd = profile
    ? `databricks auth login --profile ${profile}`
    : "databricks auth login";

  // "resolve: ~/.databrickscfg has no <name> profile configured"
  if (
    /has no .* profile configured|profile .* (does not exist|not found)/i.test(
      message,
    )
  ) {
    return `Profile not found in ~/.databrickscfg. Run \`${loginCmd}\`, or pass an existing profile via --profile.`;
  }
  // Expired/failed CLI token.
  if (
    /cannot get access token|refresh token|reauthenticate|databricks auth token|token .*expired/i.test(
      message,
    )
  ) {
    return `Your login has expired or the token could not be fetched. Run \`${loginCmd}\` to reauthenticate.`;
  }
  // No credentials resolved by any auth method.
  if (
    /cannot configure default credentials|default auth|no .*credentials/i.test(
      message,
    )
  ) {
    return `No credentials found. Run \`${loginCmd}\`, or set a profile via --profile / DATABRICKS_CONFIG_PROFILE.`;
  }
  return undefined;
}

/**
 * Layer: config. Offline presence check of each declared env var; whether a set
 * value points at a real resource is the existence layer's job.
 */
export async function checkConfig(
  target: ResourceTarget,
): Promise<LayerResult> {
  const missing: string[] = [];

  for (const envVar of target.envVars) {
    const value = process.env[envVar];
    if (value === undefined || value.trim().length === 0) {
      missing.push(envVar);
    }
  }

  if (missing.length > 0) {
    return {
      layer: "config",
      status: target.required ? "error" : "warn",
      code: target.required ? "ENV_MISSING" : "ENV_MISSING_OPTIONAL",
      detail: `${target.required ? "required" : "optional"} resource is missing env var(s): ${missing.join(", ")}`,
    };
  }

  return { layer: "config", status: "ok" };
}

/** Layer: existence. Dispatches to the per-type probe in `checks-existence.ts`. */
export async function checkExistence(
  target: ResourceTarget,
  client: unknown,
): Promise<LayerResult> {
  return runExistenceProbe(client, target);
}
