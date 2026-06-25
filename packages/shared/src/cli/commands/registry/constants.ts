/** shadcn registry namespace consumers reference, e.g. `@appkit/metric-card`. */
export const REGISTRY_NAMESPACE = "@appkit";

/**
 * The registry is served directly from the public GitHub repo over
 * raw.githubusercontent.com — no separate hosting. Built items live under
 * `public/r/` on the default branch; the manifest at the repo root.
 */
export const REGISTRY_RAW_BASE_URL =
  "https://raw.githubusercontent.com/databricks/appkit-registry/main";

/** URL template written into the consumer's components.json `registries` map. */
export const REGISTRY_ITEM_URL_TEMPLATE = `${REGISTRY_RAW_BASE_URL}/public/r/{name}.json`;

/** Manifest used by `appkit registry list` to enumerate available components. */
export const REGISTRY_INDEX_URL = `${REGISTRY_RAW_BASE_URL}/registry.json`;
