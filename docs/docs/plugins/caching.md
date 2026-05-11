---
sidebar_position: 9
---

# Caching

AppKit provides both global and plugin-level caching capabilities.

## Global cache configuration

```ts
await createApp({
  plugins: [server(), analytics({})],
  cache: {
    enabled: true,
    ttl: 3600,              // seconds
    strictPersistence: false,
  },
});
```

Storage auto-selects **Lakebase Autoscaling persistent cache when healthy**, otherwise falls back to in-memory.

The database-backed cache requires the same Lakebase environment variables as the [Lakebase plugin](./lakebase.md#environment-variables) (`PGHOST`, `PGDATABASE`, `LAKEBASE_ENDPOINT`, `PGSSLMODE`).

## Plugin-level caching

Inside a Plugin subclass:

```ts
const value = await this.cache.getOrExecute(
  ["myPlugin", "data", userId],
  async () => expensiveWork(),
  userKey,
  { ttl: 300 },
);
```
