import { createHash } from "node:crypto";

import type { Request } from "express";
import {
  createDevOboIdentityProvider,
  isServicePrincipalUser,
  loadDevOboIdentityFromEnvironment,
} from "shared";

import { getClientOptions } from "../../context/client-options";
import { DatabasePluginError } from "../../database/errors";
import { createLogger } from "../../logging/logger";
import { ApiError, createWorkspaceClient } from "../../workspace-client";
import { isLocalRequest } from "../server/dev-obo-middleware";
import { isPlainObject } from "./crud/contract";
import type { Actor } from "./operations";

const logger = createLogger("database:operations");

/** How long the workspace may take to name the caller. */
const ME_TIMEOUT_MS = 10_000;
/** How long a verified token names its caller, as for the local OBO identity. */
const ACTOR_TTL_MS = 30_000;
/** Verified tokens kept per resolver; the oldest leaves first. */
const MAX_VERIFIED_ACTORS = 1000;
/** An OAuth access token is a few kilobytes; a longer header is not one. */
const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_ORIGIN_LENGTH = 2048;

/** The signed-in developer the local OBO loader verified with the workspace. */
type LocalIdentity = Awaited<
  ReturnType<typeof loadDevOboIdentityFromEnvironment>
>;

/**
 * Where operation requests come from, chosen once from deployment
 * configuration. Choosing a boundary authenticates nobody: an Apps request
 * still needs a token the workspace accepts, and a local request still needs
 * the signed-in developer and a loopback origin.
 */
type ActorBoundary =
  | { readonly kind: "apps"; readonly host: string }
  | {
      readonly kind: "local";
      readonly host: string;
      readonly identity: () => Promise<LocalIdentity>;
    }
  | { readonly kind: "unsupported" };

/** A verified caller and the opaque session discriminator its responses carry. */
export interface AuthenticatedActor {
  readonly actor: Actor;
  readonly discriminator: string;
}

/** Resolve the caller once per request; `undefined` means unauthenticated. */
export type ActorResolver = (
  req: Request,
) => Promise<AuthenticatedActor | undefined>;

function canonicalHost(host: string): string | undefined {
  try {
    return new URL(/^https?:\/\//i.test(host) ? host : `https://${host}`)
      .origin;
  } catch {
    return undefined;
  }
}

/**
 * Pick the boundary from deployment configuration. `host` is the workspace
 * the service principal is configured for, never a request header. Local
 * development needs the explicit credentials the local OBO middleware uses.
 * Every other deployment fails closed.
 */
export function selectActorBoundary(
  host: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ActorBoundary {
  const workspace = host ? canonicalHost(host) : undefined;
  if (!workspace) return { kind: "unsupported" };
  if (env.NODE_ENV === "development") {
    const explicit =
      env.DATABRICKS_TOKEN?.trim() || env.DATABRICKS_CONFIG_PROFILE?.trim();
    if (!explicit || env.APPKIT_DEV_OBO === "false") {
      return { kind: "unsupported" };
    }
    return {
      kind: "local",
      host: workspace,
      identity: createDevOboIdentityProvider(() =>
        loadDevOboIdentityFromEnvironment(env),
      ),
    };
  }
  return env.DATABRICKS_APP_NAME
    ? { kind: "apps", host: workspace }
    : { kind: "unsupported" };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** Read the workspace's answer without trusting any field it lacks. */
function actorFromUser(user: unknown): Actor | undefined {
  if (!isPlainObject(user) || isServicePrincipalUser(user)) return undefined;
  const { id, userName, active } = user;
  if (typeof id !== "string" || id.length === 0 || active === false) {
    return undefined;
  }
  return Object.freeze(
    typeof userName === "string" ? { id, email: userName } : { id },
  );
}

function forwardedToken(req: Request): string | undefined {
  const header = req.headers["x-forwarded-access-token"];
  const token = typeof header === "string" ? header.trim() : "";
  return token && Buffer.byteLength(token, "utf8") <= MAX_TOKEN_BYTES
    ? token
    : undefined;
}

/**
 * Ask the workspace who owns a forwarded user token. The client carries only
 * that token, so a rejected token can never fall back to the service
 * principal, and identity headers beside it are never read. The raw SCIM
 * document is read because the typed client drops `applicationId`.
 */
async function verifyToken(
  host: string,
  token: string,
): Promise<Actor | undefined> {
  const client = createWorkspaceClient({
    token,
    host,
    clientOptions: getClientOptions(),
  });
  try {
    const response = await client.request({
      method: "GET",
      path: "/api/2.0/preview/scim/v2/Me",
      headers: new Headers({ Accept: "application/json" }),
      signal: AbortSignal.timeout(ME_TIMEOUT_MS),
    });
    return actorFromUser(await response.json());
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.statusCode === 401 || error.statusCode === 403)
    ) {
      return undefined;
    }
    logger.warn(
      "Workspace identity check failed (%s); answering 503",
      errorName(error),
    );
    throw new DatabasePluginError("TRANSIENT", "read");
  }
}

async function localActor(
  identity: () => Promise<LocalIdentity>,
): Promise<Actor | undefined> {
  try {
    const { userId, email } = await identity();
    return Object.freeze(email ? { id: userId, email } : { id: userId });
  } catch {
    // The loader's failure can carry CLI output; only the fact is logged.
    logger.warn(
      "Local database operations could not load the signed-in Databricks identity",
    );
    return undefined;
  }
}

/** SHA-256 of the workspace and a canonical actor id or a token, joined by NUL. */
function workspaceDigest(host: string, value: string): string {
  return createHash("sha256").update(`${host}\0${value}`).digest("hex");
}

function authenticated(
  host: string,
  actor: Actor | undefined,
): AuthenticatedActor | undefined {
  return actor && { actor, discriminator: workspaceDigest(host, actor.id) };
}

/**
 * Verify each forwarded token once per TTL, keyed by its digest so the raw
 * token is never held. Concurrent requests share one in-flight check, and
 * only a verified actor is kept: a refusal or a failure is asked again.
 */
function appsResolver(host: string): ActorResolver {
  const verified = new Map<string, { actor: Actor; verifiedAt: number }>();
  const pending = new Map<string, Promise<Actor | undefined>>();
  const check = (key: string, token: string): Promise<Actor | undefined> => {
    const inFlight = pending.get(key);
    if (inFlight) return inFlight;
    const started = verifyToken(host, token)
      .then((actor) => {
        if (actor) {
          if (verified.size >= MAX_VERIFIED_ACTORS) {
            const [oldest] = verified.keys();
            verified.delete(oldest);
          }
          verified.set(key, { actor, verifiedAt: Date.now() });
        }
        return actor;
      })
      .finally(() => pending.delete(key));
    pending.set(key, started);
    return started;
  };
  return async (req) => {
    const token = forwardedToken(req);
    if (!token) return undefined;
    const key = workspaceDigest(host, token);
    const cached = verified.get(key);
    if (cached && Date.now() - cached.verifiedAt < ACTOR_TTL_MS) {
      return authenticated(host, cached.actor);
    }
    verified.delete(key);
    return authenticated(host, await check(key, token));
  };
}

/** Resolve operation callers at the selected boundary. */
export function createActorResolver(boundary: ActorBoundary): ActorResolver {
  switch (boundary.kind) {
    case "apps":
      return appsResolver(boundary.host);
    case "local":
      // Forwarded headers are ignored: only the signed-in developer, on loopback.
      return async (req) =>
        isLocalRequest(req)
          ? authenticated(boundary.host, await localActor(boundary.identity))
          : undefined;
    case "unsupported":
      return async () => undefined;
  }
}

function forwardedHost(req: Request): string | undefined {
  const forwarded = req.headers["x-forwarded-host"];
  if (typeof forwarded === "string") return forwarded.split(",")[0]?.trim();
  return req.headers.host;
}

/**
 * Whether a browser could have sent this request only from the app's own
 * pages. Fetch metadata decides when present; reads also accept a direct
 * navigation. Without it, an `Origin` must name the host the request reached.
 * A request with neither header did not come from a browser page.
 */
export function isSameOriginRequest(req: Request): boolean {
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined) {
    return site === "same-origin" || (site === "none" && req.method === "GET");
  }
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (origin.length > MAX_ORIGIN_LENGTH) return false;
  try {
    const url = new URL(origin);
    return url.origin === origin && url.host === forwardedHost(req);
  } catch {
    return false;
  }
}
