import {
  fetchWithToken,
  NeonPostgrestClient,
} from "@neondatabase/postgrest-js";
import { ConfigurationError } from "@/errors";
import { createLogger } from "@/logging/logger";

const logger = createLogger("connectors:lakebase:postgrest");

/**
 * A function that resolves a Lakebase token.
 * @example
 * ```ts
 * const resolveToken = async () => {
 *   const token = await getLakebaseServicePrincipalToken();
 *   return token;
 * };
 * ```
 */
export type LakebaseTokenResolver = () => Promise<string | null>;

/**
 * Configuration for creating a Lakebase PostgREST client.
 * @example
 * ```ts
 * const config: LakebasePostgrestClientConfig = {
 *   dataApiUrl: "https://data-api.lakebase.databricks.com",
 *   schema: "app",
 *   resolveToken: async () => {
 *     const token = await getLakebaseServicePrincipalToken();
 *     return token;
 *   },
 * };
 * ```
 */
export interface LakebasePostgrestClientConfig {
  dataApiUrl?: string;
  schema?: string;
  resolveToken: LakebaseTokenResolver;
  fetch?: typeof fetch;
}

// Add unknown type to avoid importing NeonPostgrestClient type.
export type LakebasePostgrestClient = unknown;

/**
 * Create a Lakebase PostgREST client.
 *
 * @param config - Configuration for creating a Lakebase PostgREST client.
 * @returns A Lakebase PostgREST client.
 */
export function createLakebasePostgrestClient(
  config: LakebasePostgrestClientConfig,
): LakebasePostgrestClient {
  const dataApiUrl = config.dataApiUrl ?? process.env.LAKEBASE_DATA_API_URL;

  if (!dataApiUrl) {
    throw ConfigurationError.missingEnvVar("LAKEBASE_DATA_API_URL");
  }

  logger.debug("createLakebasePostgrestClient: dataApiUrl", dataApiUrl);

  return new NeonPostgrestClient({
    dataApiUrl,
    options: {
      db: { schema: config.schema ?? "app" },
      global: {
        fetch: fetchWithToken(config.resolveToken, config.fetch),
      },
    },
  });
}
