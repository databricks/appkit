# Interface: CacheConfig

Defined in: shared/src/cache.ts:36

Configuration for caching

## Indexable

```ts
[key: string]: unknown
```

## Properties

### cacheKey?

```ts
optional cacheKey: (string | number | object)[];
```

Defined in: shared/src/cache.ts:46

Cache key

***

### cleanupProbability?

```ts
optional cleanupProbability: number;
```

Defined in: shared/src/cache.ts:55

Probability (0-1) of triggering cleanup on each get operation

***

### enabled?

```ts
optional enabled: boolean;
```

Defined in: shared/src/cache.ts:38

Whether caching is enabled

***

### evictionCheckProbability?

```ts
optional evictionCheckProbability: number;
```

Defined in: shared/src/cache.ts:58

Probability (0-1) of checking total bytes on each write operation

***

### maxBytes?

```ts
optional maxBytes: number;
```

Defined in: shared/src/cache.ts:42

Maximum number of bytes in the cache

***

### maxEntryBytes?

```ts
optional maxEntryBytes: number;
```

Defined in: shared/src/cache.ts:61

Maximum number of bytes per entry in the cache

***

### maxSize?

```ts
optional maxSize: number;
```

Defined in: shared/src/cache.ts:44

Maximum number of entries in the cache

***

### storage?

```ts
optional storage: CacheStorage;
```

Defined in: shared/src/cache.ts:48

Cache Storage provider instance

***

### strictPersistence?

```ts
optional strictPersistence: boolean;
```

Defined in: shared/src/cache.ts:50

Whether to enforce strict persistence

***

### telemetry?

```ts
optional telemetry: TelemetryOptions;
```

Defined in: shared/src/cache.ts:52

Telemetry configuration

***

### ttl?

```ts
optional ttl: number;
```

Defined in: shared/src/cache.ts:40

Time to live in seconds
