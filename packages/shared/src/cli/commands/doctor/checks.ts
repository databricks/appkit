/**
 * The `auth` and `config` layer checks. (The `existence` layer's per-type
 * probes live in `checks-existence.ts`.)
 */

import { getServiceClient, SdkNotInstalledError } from "./databricks-client";
import type {
  AuthCheckResult,
  DoctorOptions,
  LayerResult,
  ResourceTarget,
} from "./types";
import { errorMessage, withTimeout } from "./utils";

/** The auth result plus the resolved client (present only on success). */
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
 * Strips URL userinfo (`user:pass@`) from a host, so credentials someone
 * embedded in `DATABRICKS_HOST` never reach the report or `--json`. Returns the
 * input unchanged when it has no userinfo or isn't a parseable URL.
 */
export function sanitizeHost(host: string | undefined): string | undefined {
  if (host === undefined) return undefined;
  try {
    const url = new URL(host);
    if (!url.username && !url.password) return host;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return host;
  }
}

/**
 * Validates `DATABRICKS_HOST` before the SDK sees it, so an unfilled placeholder
 * gets a clear message instead of the SDK's opaque credentials error. Returns an
 * error message, or null when the host is acceptable or unset.
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

  // Placeholders like "https://..." parse but have no real dotted label.
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
  // Validate the raw value, but only ever store/report the sanitized one so
  // credentials embedded in the URL (user:pass@) never reach the report/--json.
  const rawHost = process.env.DATABRICKS_HOST;
  const host = sanitizeHost(rawHost);
  // The identity source shown in the report: explicit --profile, else the env
  // var the SDK would pick up.
  const profile = options.profile ?? process.env.DATABRICKS_CONFIG_PROFILE;
  const hostError = validateHost(rawHost);
  if (hostError) {
    return {
      result: {
        status: "error",
        code: "HOST_INVALID",
        detail: hostError,
        host,
        profile,
      },
    };
  }

  try {
    const { client } = await getServiceClient(options.profile);
    // Bound the live call so an unresponsive workspace can't hang the CLI; a
    // timeout throws and is reported as an auth failure below.
    const me = await withTimeout(
      (client as CurrentUserClient).currentUser.me(),
    );
    const who = me.userName ?? me.id ?? "unknown";

    return {
      client,
      result: {
        status: "ok",
        code: "AUTH_OK",
        detail: `authenticated as ${who}`,
        host,
        profile,
      },
    };
  } catch (err) {
    if (err instanceof SdkNotInstalledError) {
      return {
        result: {
          status: "error",
          code: "SDK_NOT_INSTALLED",
          detail: err.message,
          profile,
        },
      };
    }
    const raw = errorMessage(err);
    // When no profile was given up front, recover the one the SDK resolved (it's
    // embedded in the error) and mark it "(resolved)".
    const sdkProfile = raw.match(/--profile\s+(\S+)/)?.[1];
    const usedProfile = profile ?? sdkProfile;
    const shownProfile =
      profile ?? (sdkProfile ? `${sdkProfile} (resolved)` : undefined);
    return {
      result: {
        status: "error",
        code: "AUTH_FAILED",
        detail: "authentication failed",
        hint: authFailureHint(raw, usedProfile),
        host,
        profile: shownProfile,
        raw,
      },
    };
  }
}

/**
 * Suggests a next action for common auth failures, matched most specific first.
 * Returns undefined for an unrecognized failure.
 *
 * `profile` is the explicit --profile, else the one the SDK resolved (DEFAULT /
 * DATABRICKS_CONFIG_PROFILE) and embedded in its error, so the login hint
 * targets what actually failed.
 */
function authFailureHint(
  message: string,
  profile?: string,
): string | undefined {
  const loginCmd = profile
    ? `databricks auth login --profile ${profile}`
    : "databricks auth login";
  // Network-level failure (unreachable host, DNS, TLS). Matched first — more
  // specific than a credential problem and needs a different fix.
  if (
    /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|getaddrinfo|certificate|self.signed|unable to verify|TLS/i.test(
      message,
    )
  ) {
    return "Check that the workspace host is correct and reachable (verify DATABRICKS_HOST or the profile's host, and that you're online).";
  }
  if (
    /has no .* profile configured|profile .* (does not exist|not found)/i.test(
      message,
    )
  ) {
    return `Run \`${loginCmd}\`, or pass an existing profile via --profile.`;
  }
  // Expired/failed token, or no credentials resolved: same next action.
  if (
    /cannot get access token|refresh token|reauthenticate|databricks auth token|token .*expired|cannot configure default credentials|default auth|no .*credentials/i.test(
      message,
    )
  ) {
    return `Run \`${loginCmd}\` and confirm the profile/host is the one you intend.`;
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
    const plural = missing.length > 1;
    const names = missing.join(", ");
    return {
      layer: "config",
      status: target.required ? "error" : "warn",
      code: target.required ? "ENV_MISSING" : "ENV_MISSING_OPTIONAL",
      detail: target.required
        ? `${names} ${plural ? "are" : "is"} not set`
        : `${names} ${plural ? "are" : "is"} not set (optional)`,
      hint: `Set ${plural ? "them" : "it"} in your .env (local) and wire ${plural ? "them" : "it"} through app.yaml + databricks.yml for deploy.`,
    };
  }

  return { layer: "config", status: "ok" };
}
