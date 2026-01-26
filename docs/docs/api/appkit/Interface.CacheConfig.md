# Interface: CacheConfig

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

Cache key

***

### cleanupProbability?

```ts
optional cleanupProbability: number;
```

Probability (0-1) of triggering cleanup on each get operation

***

### enabled?

```ts
optional enabled: boolean;
```

Whether caching is enabled

***

### evictionCheckProbability?

```ts
optional evictionCheckProbability: number;
```

Probability (0-1) of checking total bytes on each write operation

***

### maxBytes?

```ts
optional maxBytes: number;
```

Maximum number of bytes in the cache

***

### maxEntryBytes?

```ts
optional maxEntryBytes: number;
```

Maximum number of bytes per entry in the cache

***

### maxSize?

```ts
optional maxSize: number;
```

Maximum number of entries in the cache

***

### storage?

```ts
optional storage: CacheStorage;
```

Cache Storage provider instance

***

### strictPersistence?

```ts
optional strictPersistence: boolean;
```

Whether to enforce strict persistence

***

### telemetry?

```ts
optional telemetry: TelemetryOptions;
```

Telemetry configuration

***

### ttl?

```ts
optional ttl: number;
```

Time to live in seconds
