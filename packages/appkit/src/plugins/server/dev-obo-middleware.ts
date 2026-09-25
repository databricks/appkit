import type { Request, RequestHandler } from "express";
import {
  createDevOboIdentityProvider,
  loadDevOboIdentityFromEnvironment,
} from "shared";

import { createLogger } from "../../logging/logger";

const logger = createLogger("server:dev-obo");
const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
const loopbackPeers = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function isLocalRequest(req: Request): boolean {
  // Check the socket, not Express's proxy-aware IP or forwarded headers.
  if (!loopbackPeers.has(req.socket.remoteAddress ?? "")) return false;
  try {
    const origin = new URL(`http://${req.headers.host}`);
    if (
      !loopbackHosts.has(origin.hostname) ||
      origin.host !== req.headers.host ||
      Number(origin.port || 80) !== req.socket.localPort
    )
      return false;
    if (req.headers.origin && req.headers.origin !== origin.origin)
      return false;
    const site = req.headers["sec-fetch-site"];
    return !site || site === "same-origin" || site === "none";
  } catch {
    return false;
  }
}

/** Inject local user headers without changing the default execution principal. */
export function createDevOboMiddleware(): RequestHandler | undefined {
  const token = process.env.DATABRICKS_TOKEN?.trim();
  const profile = process.env.DATABRICKS_CONFIG_PROFILE?.trim();
  if (
    process.env.NODE_ENV !== "development" ||
    process.env.APPKIT_DEV_OBO === "false" ||
    (!token && !profile)
  )
    return undefined;

  const getIdentity = createDevOboIdentityProvider(() =>
    loadDevOboIdentityFromEnvironment(),
  );
  logger.info(
    `Local OBO headers enabled using ${token ? "DATABRICKS_TOKEN" : "DATABRICKS_CONFIG_PROFILE"}. Open the app on localhost. Set APPKIT_DEV_OBO=false to disable.`,
  );

  return async (req, res, next) => {
    // Preserve explicit forwarded identities, including the optional dev proxy.
    if (req.header("x-forwarded-access-token")?.trim()) {
      next();
      return;
    }
    if (!isLocalRequest(req)) {
      res.status(403).json({
        error:
          "Local OBO emulation only accepts same-origin loopback requests.",
      });
      return;
    }
    try {
      const identity = await getIdentity();
      req.headers["x-forwarded-access-token"] = identity.token;
      req.headers["x-forwarded-user"] = identity.userId;
      delete req.headers["x-forwarded-email"];
      if (identity.email) req.headers["x-forwarded-email"] = identity.email;
    } catch {
      // Never fall back to SP or expose credential-bearing CLI errors.
      res.status(401).json({
        error:
          "Local OBO credentials unavailable. Verify DATABRICKS_TOKEN and DATABRICKS_HOST, or authenticate the user profile in DATABRICKS_CONFIG_PROFILE, then retry.",
      });
      return;
    }
    next();
  };
}
