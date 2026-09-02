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

### One cache per app

Each app owns exactly one cache. `createApp` builds it from your `cache` config
and hands the same manager to every plugin it registers, so `this.cache` is the
app's cache — not a process-wide one. Two apps in the same process hold two
independent managers, and each honours its own `cache` config.

`this.cache` is read-only: a plugin cannot substitute its own manager. To vary
caching per plugin, set a plugin-level `cache` config instead:

```ts
analytics({ cache: { enabled: true, ttl: 600 } });
```

A plugin receives its cache when the app registers it. Construction alone does
not bind one, so `this.cache` is not available in a plugin's constructor —
read it from `setup()` or from a request handler, both of which run after
registration.

## Upgrading to 0.70.0

The cache became per-app in 0.70.0. Most apps need no changes: if your plugins
reach the cache through `this.cache` and you build apps with `createApp`, this
release is a no-op for you.

**`CacheManager.getInstance()` and `CacheManager.getInstanceSync()` are
removed.** There is no process-wide cache to fetch. Inside a plugin, use
`this.cache`, which the app binds for you:

```ts
// Before
const cache = CacheManager.getInstanceSync();
await cache.getOrExecute(["k"], work, userKey);

// After
await this.cache.getOrExecute(["k"], work, userKey);
```

Code outside a plugin cannot reach an app's cache directly, by design — the
manager has no public constructor. Move the cached work into a plugin.

**A plugin constructed without an app has no cache.** Previously such a plugin
picked up whichever manager happened to exist in the process. Now a cached
execution on an unregistered plugin throws `InitializationError`
(`CacheManager not initialized`) naming the plugin. Register it through
`createApp`, or in tests attach it to a test context:

```ts
import { createTestPluginContext } from "@databricks/appkit/testing";

const mock = createTestPluginContext();
await mock.attach(new MyPlugin({}));
// mock.cache is the very cache the plugin now resolves — spy or read it.
```

The most common way to hit this is reading `this.cache` in a plugin's
constructor or `setup()` before it was attached. `setup()` runs after
registration under `createApp`, so only hand-rolled construction is affected.

**`this.cache` is read-only.** A plugin that assigned its own manager
(`this.cache = new CacheManager(...)`) no longer compiles. Use a plugin-level
`cache: { enabled, ttl }` config instead — see [One cache per
app](#one-cache-per-app).
