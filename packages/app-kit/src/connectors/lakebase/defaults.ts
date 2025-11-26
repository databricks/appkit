import type { LakebaseConfig } from "./types";

/** Default configuration for Lakebase connector */
export const lakebaseDefaults: LakebaseConfig = {
  port: 5432,
  sslMode: "require",
  maxPoolSize: 10,
  idleTimeoutMs: 30_000,
  connectionTimeoutMs: 10_000,
  credentialTTLMs: 25 * 60 * 1000, // 25 minutes
};
