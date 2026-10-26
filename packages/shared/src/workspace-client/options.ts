/**
 * Options used to construct the workspace client facade. AppKit's own shape,
 * independent of any SDK: the modular clients are built from these in
 * `modular.ts`.
 */

/** User-Agent stamping: `<product>/<productVersion>` plus extra segments. */
export interface ClientOptions {
  product?: string;
  productVersion?: string;
  userAgentExtra?: Record<string, string>;
}

export interface WorkspaceClientOptions {
  /** Databricks host, e.g. https://my-workspace.cloud.databricks.com. Defaults to DATABRICKS_HOST / profile resolution. */
  host?: string;
  /** `~/.databrickscfg` profile name. Used when no host/token is provided. */
  profile?: string;
  /** Bearer token (PAT, or the user's OBO token). */
  token?: string;
  /**
   * SDK client options (product / productVersion / userAgentExtra) used to
   * stamp the outbound User-Agent. Produced by `getClientOptions()`; omitted
   * by build-time callers that don't stamp a User-Agent.
   */
  clientOptions?: ClientOptions;
}
