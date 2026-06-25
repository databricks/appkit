/** shadcn registry namespace consumers reference, e.g. `@appkit/metric-card`. */
export const REGISTRY_NAMESPACE = "@appkit";

// TODO: point at the real hosting domain once the public registry is deployed.
export const REGISTRY_BASE_URL = "https://registry.appkit.databricks.com";

/** URL template written into the consumer's components.json `registries` map. */
export const REGISTRY_ITEM_URL_TEMPLATE = `${REGISTRY_BASE_URL}/r/{name}.json`;

/** Manifest used by `appkit registry list` to enumerate available components. */
export const REGISTRY_INDEX_URL = `${REGISTRY_BASE_URL}/registry.json`;
