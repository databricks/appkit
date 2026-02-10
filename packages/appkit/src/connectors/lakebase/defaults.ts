/** Default configuration values for the Lakebase connector */
export const lakebaseDefaults = {
  port: 5432,
  sslMode: "require" as const,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
};
