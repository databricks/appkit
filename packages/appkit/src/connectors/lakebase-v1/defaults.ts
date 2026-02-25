import type { LakebaseV1Config } from "./types";

/**
 * Default configuration for Lakebase V1 connector
 *
 * @deprecated This connector is for Lakebase Provisioned only.
 * For new projects, use Lakebase Autoscaling: https://docs.databricks.com/aws/en/oltp/projects/
 */
export const lakebaseV1Defaults: LakebaseV1Config = {
  port: 5432,
  sslMode: "require",
  maxPoolSize: 10,
  idleTimeoutMs: 30_000,
  connectionTimeoutMs: 10_000,
};
