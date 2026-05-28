import { analytics, createApp, server } from "@databricks/appkit";

/**
 * TaskFlow private-preview demo. If PGHOST is set, route the WAL to
 * Lakebase Postgres (TaskFlow reads PG* and rotates credentials itself);
 * otherwise SQLite locally.
 */
createApp({
  task: {
    engine: { staleThresholdMs: 5000, recoveryIntervalMs: 1000 },
    executor: { heartbeatIntervalMs: 1500 },
    storage: process.env.PGHOST
      ? { backend: "lakebase" }
      : { backend: "sqlite", databasePath: ".appkit/tasks/tasks.db" },
  },
  plugins: [server(), analytics({})],
});
