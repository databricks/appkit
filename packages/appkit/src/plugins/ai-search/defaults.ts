import type { PluginExecuteConfig } from "shared";

export const aiSearchDefaults: PluginExecuteConfig = {
  // Short TTL: VS results shift as the index resyncs, so cache only long
  // enough to absorb bursts without serving stale results.
  cache: { enabled: true, ttl: 60 },
  retry: { enabled: true, initialDelay: 1000, attempts: 3 },
  timeout: 30_000,
};
