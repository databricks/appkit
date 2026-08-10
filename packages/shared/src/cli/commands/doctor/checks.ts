/**
 * The `auth` and `config` layer checks. (The `existence` layer's per-type
 * probes live in `checks-existence.ts`.)
 */

import {
  getProfileHost,
  getServiceClient,
  SdkNotInstalledError,
} from "./databricks-client";
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

/** Just the resolved config off a WorkspaceClient, read structurally to keep
 * `shared` SDK-free. */
interface ConfiguredClient {
  config?: { host?: unknown };
}

/**
 * The host the SDK actually resolved. This is the authority for what was
 * contacted: `DATABRICKS_HOST` wins the host when set, but a profile supplies it
 * otherwise, so the env var alone can't tell you the workspace in play.
 *
 * Only populated once the SDK has resolved its config, which it does lazily on
 * the first API call — reading it right after construction yields undefined.
 */
function resolvedHostOf(client: unknown): string | undefined {
  const host = (client as ConfiguredClient | undefined)?.config?.host;
  return typeof host === "string" && host.length > 0 ? host : undefined;
}

/** Compares hosts ignoring scheme, trailing slash, and case, so
 * `https://foo.com/` and `foo.com` count as the same workspace. */
function sameHost(a: string, b: string): boolean {
  const normalize = (h: string) =>
    h
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/+$/, "");
  return normalize(a) === normalize(b);
}

/**
 * Warns when `DATABRICKS_HOST` and the named profile point at different
 * workspaces. The SDK resolves these per-field — env wins the host while the
 * profile still supplies the credentials — so this combination silently
 * authenticates with one workspace's token against another's URL. Almost always
 * a mistake, and the resulting 401/403 gives no hint of the split.
 */
async function hostProfileConflict(
  envHost: string | undefined,
  profile: string | undefined,
): Promise<string | undefined> {
  if (!envHost || !profile) return undefined;
  const profileHost = await getProfileHost(profile);
  if (!profileHost || sameHost(envHost, profileHost)) return undefined;
  return (
    `DATABRICKS_HOST (${envHost}) and profile "${profile}" ` +
    `(${profileHost}) point at different workspaces. DATABRICKS_HOST wins the ` +
    `host while the profile still supplies credentials — unset one of them.`
  );
}

/**
 * Last-resort host recovery for when the client never got built: the SDK's
 * ConfigError appends the resolved config as `host=<url>, profile=…`.
 */
function hostFromError(message: string): string | undefined {
  const match = message.match(/host=([^\s,]+)/);
  // The config list is prose-terminated ("…databricks.com."), so drop trailing
  // punctuation the capture picked up.
  return match ? match[1].replace(/[.,]+$/, "") : undefined;
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
    // An unparseable host still can't be echoed verbatim — a typo'd scheme
    // (`ht!tp://user:pass@x`) keeps its credentials otherwise. Strip any
    // `userinfo@` span textually, since URL parsing is unavailable here. Covers
    // both a scheme-prefixed host and a bare `user:pass@host`.
    return host.replace(/^([^/@]*\/\/)?[^/@]*@/, (_, scheme) => scheme ?? "");
  }
}

/**
 * Validates `DATABRICKS_HOST` before the SDK sees it, so an unfilled placeholder
 * gets a clear message instead of the SDK's opaque credentials error. Returns an
 * error message, or null when the host is acceptable or unset.
 *
 * Every message quotes the **sanitized** host: `detail` prints unconditionally in
 * both the human report and `--json` (only `raw` is `--detail`-gated), so echoing
 * the raw value would leak `user:pass@` credentials into CI logs.
 */
export function validateHost(host: string | undefined): string | null {
  if (host === undefined || host.trim().length === 0) return null;
  const shown = sanitizeHost(host);

  let url: URL;
  try {
    url = new URL(host);
  } catch {
    return `DATABRICKS_HOST is not a valid URL: "${shown}"`;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return `DATABRICKS_HOST must be an http(s) URL: "${shown}"`;
  }

  // Reject only what can't name a host at all: a hostname with no alphanumeric
  // character, e.g. the template's unfilled "https://...". Requiring a dotted
  // label instead would reject legitimate single-label hosts — `localhost`, a
  // tunnel, or an internal DNS name.
  if (!/[a-z0-9]/i.test(url.hostname)) {
    return `DATABRICKS_HOST looks like an unfilled placeholder: "${shown}"`;
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

  // An env/profile split is a config problem, so it's worth reporting whether or
  // not the credentials happen to work. Resolved offline from ~/.databrickscfg.
  const conflict = await hostProfileConflict(host, profile);

  // Holds the client so the catch block can read the host the SDK resolved
  // (which may have come from the profile, not env).
  let built: unknown;
  try {
    const { client } = await getServiceClient(options.profile);
    built = client;
    // Bound the live call so an unresponsive workspace can't hang the CLI; a
    // timeout throws and is reported as an auth failure below.
    const me = await withTimeout(
      (client as CurrentUserClient).currentUser.me(),
    );
    const who = me.userName ?? me.id ?? "unknown";
    // Read only now: the SDK resolves its config lazily on the first call, so
    // before me() the host is still undefined.
    const resolvedHost = sanitizeHost(resolvedHostOf(client)) ?? host;

    // Credentials work, but the env/profile split still needs fixing — surface
    // it as a warning rather than letting a green tick imply all is well.
    if (conflict) {
      return {
        client,
        result: {
          status: "warn",
          code: "HOST_PROFILE_CONFLICT",
          detail: `authenticated as ${who}`,
          hint: conflict,
          host: resolvedHost,
          profile,
        },
      };
    }

    return {
      client,
      result: {
        status: "ok",
        code: "AUTH_OK",
        detail: `authenticated as ${who}`,
        host: resolvedHost,
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
    // Prefer the host the SDK resolved (covers a profile-supplied host), then
    // the one embedded in its error, then the raw env var.
    const shownHost =
      sanitizeHost(resolvedHostOf(built) ?? hostFromError(raw)) ?? host;
    return {
      result: {
        status: "error",
        code: "AUTH_FAILED",
        detail: "authentication failed",
        // A conflict explains the failure better than a generic login hint.
        hint: conflict ?? authFailureHint(raw, usedProfile),
        host: shownHost,
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

/** The default local env file, matching the `.env` the CLI auto-loads. */
export const DEFAULT_ENV_FILE = ".env";

/** What the config layer needs beyond the target to name the *right* file and
 * give advice that fits the app's actual deploy wiring. */
export interface ConfigCheckContext {
  /** Where local values were loaded from: `.env`, or `--env-file`'s path. Named
   * in the message so it's clear this is the local env file, not `app.yaml` /
   * `databricks.yml`. */
  envFile: string;
  /** Env vars `app.yaml` already wires. Lets the hint be dropped entirely for a
   * var whose deploy wiring is already correct. */
  wiredEnvVars: ReadonlySet<string>;
}

/**
 * Layer: config. Offline presence check of each declared env var; whether a set
 * value points at a real resource is the existence layer's job.
 *
 * The message names the env file explicitly, because "not set" alone reads as
 * ambiguous between the three files a var can be declared in — the local env
 * file, `app.yaml`, and `databricks.yml`. This layer only ever means the first.
 */
export function checkConfig(
  target: ResourceTarget,
  ctx: ConfigCheckContext,
): LayerResult {
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
    const them = plural ? "them" : "it";
    // Deploy reads app.yaml, never the env file. When wiring is already correct
    // there's nothing to add beyond "set it", which the detail line just said —
    // so no hint at all. Only genuinely-missing wiring earns one.
    const allWired = missing.every((name) => ctx.wiredEnvVars.has(name));
    return {
      layer: "config",
      status: target.required ? "error" : "warn",
      code: target.required ? "ENV_MISSING" : "ENV_MISSING_OPTIONAL",
      detail: `${names} ${plural ? "are" : "is"} not set in \`${ctx.envFile}\`${
        target.required ? "" : " (optional)"
      }`,
      hint: allWired
        ? undefined
        : `Add ${them} to \`${ctx.envFile}\` to run locally, and wire ${them} through app.yaml + databricks.yml for deploy.`,
    };
  }

  return { layer: "config", status: "ok" };
}
