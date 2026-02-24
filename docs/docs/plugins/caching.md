---
sidebar_position: 8
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

Storage auto-selects **Lakebase V1 (Provisioned) persistent cache when healthy**, otherwise falls back to in-memory. Support for Lakebase Autoscaling coming soon.

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
