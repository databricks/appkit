/** shadcn registry namespace consumers reference, e.g. `@databricks-appkit/metric-card`. */
export const REGISTRY_NAMESPACE = "@databricks-appkit";

/**
 * A plain JS identifier. A plugin's export name is interpolated into the user's
 * server source, so it's validated against this before use — a registry item is
 * untrusted, and anything else could inject code.
 */
export const JS_IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** GitHub repo hosting the registry, and the branch the built items live on. */
export const REGISTRY_REPO = "databricks/appkit-registry";
export const REGISTRY_REF = "main";

/**
 * The registry is a public repo, so items are fetched directly from
 * raw.githubusercontent.com with no auth.
 */
const PUBLIC_RAW_BASE = `https://raw.githubusercontent.com/${REGISTRY_REPO}/${REGISTRY_REF}`;
export const REGISTRY_ITEM_URL_TEMPLATE = `${PUBLIC_RAW_BASE}/public/r/{name}.json`;
export const REGISTRY_INDEX_URL = `${PUBLIC_RAW_BASE}/registry.json`;
