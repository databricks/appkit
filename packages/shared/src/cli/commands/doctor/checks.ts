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
  // What the report shows as the identity source: an explicit --profile, else
  // the env var the SDK would pick up, so "which profile?" is never a mystery.
  const profile = options.profile ?? process.env.DATABRICKS_CONFIG_PROFILE;
  const hostError = validateHost(host);
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
    const me = await (client as CurrentUserClient).currentUser.me();
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
    const raw = err instanceof Error ? err.message : String(err);
    // If we didn't know the profile up front, recover the one the SDK actually
    // resolved (embedded in its error) and mark it "(resolved)" so the header
    // reveals which profile was used — otherwise a default fallback is invisible.
    const sdkProfile = raw.match(/--profile\s+(\S+)/)?.[1];
    const shownProfile =
      profile ?? (sdkProfile ? `${sdkProfile} (resolved)` : undefined);
    return {
      result: {
        status: "error",
        code: "AUTH_FAILED",
        // Keep the headline short and let the hint explain the fix; the raw SDK
        // message is carried separately for `--detail` / `--json`.
        detail: "authentication failed",
        hint: authFailureHint(raw, profile),
        host,
        profile: shownProfile,
        raw,
      },
    };
  }
}

/**
 * Suggests a next action for common auth failures. Hints are phrased as
 * something to *do* (not a restatement of the error) and, since a failure may
 * mean the wrong profile/host is in play, tell the user to confirm which
 * profile/host they're targeting. Patterns are matched most specific first;
 * returns undefined for an unrecognized failure.
 */
function authFailureHint(
  message: string,
  profile?: string,
): string | undefined {
  // The SDK resolves a profile even when the user gave none (falling back to
  // DEFAULT / DATABRICKS_CONFIG_PROFILE), and its error embeds that name (e.g.
  // "databricks auth login --profile DEFAULT"). Prefer the explicit profile,
  // then the one the SDK actually used, so the hint points at the profile that
  // truly failed — not a bare `databricks auth login` that reauths the wrong one.
  const usedProfile = profile ?? message.match(/--profile\s+(\S+)/)?.[1];
  const loginCmd = usedProfile
    ? `databricks auth login --profile ${usedProfile}`
    : "databricks auth login";
  // The profile/host in use is already shown in the report header and in the
  // login command, so hints don't repeat it — they just nudge the user to
  // sanity-check the target rather than blindly re-logging-in.
  // Network-level failure: the host is unreachable (bad workspace URL, DNS,
  // offline, or TLS). Matched first — it's more specific than a credential
  // problem and needs a different fix.
  if (
    /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|getaddrinfo|certificate|self.signed|unable to verify|TLS/i.test(
      message,
    )
  ) {
    return "Check that the workspace host is correct and reachable (verify DATABRICKS_HOST or the profile's host, and that you're online).";
  }
  // "resolve: ~/.databrickscfg has no <name> profile configured"
  if (
    /has no .* profile configured|profile .* (does not exist|not found)/i.test(
      message,
    )
  ) {
    return `Run \`${loginCmd}\`, or pass an existing profile via --profile.`;
  }
  // Expired/failed CLI token, or no credentials resolved by any method — both
  // point at the same next action: log in and verify the target.
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
      // The env var name(s) do the work — the report bolds SCREAMING_SNAKE
      // names. Optional resources say so: a missing optional is a warn, not a
      // blocker.
      detail: target.required
        ? `${names} ${plural ? "are" : "is"} not set`
        : `${names} ${plural ? "are" : "is"} not set (optional)`,
      hint: `Set ${plural ? "them" : "it"} in your .env (local) and wire ${plural ? "them" : "it"} through app.yaml + databricks.yml for deploy.`,
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
