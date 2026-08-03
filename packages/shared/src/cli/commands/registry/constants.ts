import { spawnSync } from "node:child_process";

/** shadcn registry namespace consumers reference, e.g. `@databricks-appkit/metric-card`. */
export const REGISTRY_NAMESPACE = "@databricks-appkit";

/** GitHub repo hosting the registry, and the branch the built items live on. */
export const REGISTRY_REPO = "databricks/appkit-registry";
export const REGISTRY_REF = "main";

/**
 * Public hosting: once the repo is public, items are fetchable directly from
 * raw.githubusercontent.com with no auth.
 */
const PUBLIC_RAW_BASE = `https://raw.githubusercontent.com/${REGISTRY_REPO}/${REGISTRY_REF}`;
export const REGISTRY_ITEM_URL_TEMPLATE = `${PUBLIC_RAW_BASE}/public/r/{name}.json`;
export const REGISTRY_INDEX_URL = `${PUBLIC_RAW_BASE}/registry.json`;

/**
 * Private/internal hosting: while the repo is internal, files are fetched via
 * the GitHub Contents API with a token. `Accept: application/vnd.github.raw`
 * makes the API return the file bytes directly (the registry-item JSON).
 */
const GH_CONTENTS_API = `https://api.github.com/repos/${REGISTRY_REPO}/contents`;
export const REGISTRY_ITEM_API_TEMPLATE = `${GH_CONTENTS_API}/public/r/{name}.json?ref=${REGISTRY_REF}`;
export const REGISTRY_INDEX_API_URL = `${GH_CONTENTS_API}/registry.json?ref=${REGISTRY_REF}`;

/** Env vars checked (in order) for a token granting read access to the repo. */
export const TOKEN_ENV_VARS = [
  "APPKIT_REGISTRY_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
];

export interface RegistryToken {
  envName: string;
  value: string;
}

/**
 * Resolves a token granting read access to the registry repo: first the env
 * vars in {@link TOKEN_ENV_VARS}, then the GitHub CLI (`gh auth token`) if the
 * user is logged in. Returns null if none are available.
 */
export function resolveToken(
  env: NodeJS.ProcessEnv = process.env,
): RegistryToken | null {
  for (const envName of TOKEN_ENV_VARS) {
    const value = env[envName];
    if (value) return { envName, value };
  }
  try {
    const res = spawnSync("gh", ["auth", "token"], { encoding: "utf-8" });
    const value = res.status === 0 ? res.stdout.trim() : "";
    if (value) return { envName: "gh auth token", value };
  } catch {
    // gh not installed or not on PATH — fall through.
  }
  return null;
}
