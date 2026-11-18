import type express from "express";

/** Assets prefixes that are served through the remote tunnel */
export const REMOTE_TUNNEL_ASSET_PREFIXES = [
  "/@vite/",
  "/@fs/",
  "/node_modules/.vite/deps/",
  "/node_modules/vite/",
  "/src/",
  "/@react-refresh",
];

/**
 * Check if the server is running in local development mode
 * - NODE_ENV is set to "development"
 * @param env - the environment variables
 * @returns true if the server is running in local development mode
 */
export function isLocalDev(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "development";
}

/**
 * Check if the environment allows the remote tunnel (Remote Bridge).
 *
 * The Remote Bridge serves UI and query files from a developer's machine
 * through the deployed app, so a deployed app has it off unless it opts in.
 * DISABLE_REMOTE_SERVING defaults to true: only the exact value "false"
 * turns the bridge on, and unset or any other value leaves it off.
 * - not in local development mode
 * - DISABLE_REMOTE_SERVING is set to "false" (opt-in)
 * - DATABRICKS_CLIENT_SECRET is set
 * @param env - the environment variables
 * @returns true if the environment allows the remote tunnel
 */
export function isRemoteTunnelAllowedByEnv(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    !isLocalDev(env) &&
    env.DISABLE_REMOTE_SERVING === "false" &&
    Boolean(env.DATABRICKS_CLIENT_SECRET)
  );
}

/**
 * Check if the request has a dev query parameter
 * @param req - the request
 * @returns true if the request has a dev query parameter
 */
export function hasDevQuery(req: express.Request): boolean {
  const queryParams = req.query;

  return "dev" in queryParams;
}

/**
 * Check if the request is an asset request
 * @param req - the request
 * @returns true if the request is an asset request
 */
export function isRemoteTunnelAssetRequest(req: express.Request): boolean {
  const path = req.originalUrl;
  return REMOTE_TUNNEL_ASSET_PREFIXES.some((prefix) => path.startsWith(prefix));
}
