# Interface: CacheConfig

Defined in: [shared/src/cache.ts:36](https://github.com/databricks/appkit/blob/main/packages/shared/src/cache.ts#L36)

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

Defined in: [shared/src/cache.ts:46](https://github.com/databricks/appkit/blob/main/packages/shared/src/cache.ts#L46)

Cache key

***

### cleanupProbability?

```ts
optional cleanupProbability: number;
```

Defined in: [shared/src/cache.ts:55](https://github.com/databricks/appkit/blob/main/packages/shared/src/cache.ts#L55)

Probability (0-1) of triggering cleanup on each get operation

***

### enabled?

```ts
optional enabled: boolean;
```

Defined in: [shared/src/cache.ts:38](https://github.com/databricks/appkit/blob/main/packages/shared/src/cache.ts#L38)

Whether caching is enabled

***

### evictionCheckProbability?

```ts
optional evictionCheckProbability: number;
```

Defined in: [shared/src/cache.ts:58](https://github.com/databricks/appkit/blob/main/packages/shared/src/cache.ts#L58)

Probability (0-1) of checking total bytes on each write operation

***

### maxBytes?

```ts
optional maxBytes: number;
```

Defined in: [shared/src/cache.ts:42](https://github.com/databricks/appkit/blob/main/packages/shared/src/cache.ts#L42)

Maximum number of bytes in the cache

***

### maxEntryBytes?

```ts
optional maxEntryBytes: number;
```

Defined in: [shared/src/cache.ts:61](https://github.com/databricks/appkit/blob/main/packages/shared/src/cache.ts#L61)

Maximum number of bytes per entry in the cache

***

### maxSize?

```ts
optional maxSize: number;
```

Defined in: [shared/src/cache.ts:44](https://github.com/databricks/appkit/blob/main/packages/shared/src/cache.ts#L44)

Maximum number of entries in the cache

***

### storage?

```ts
optional storage: CacheStorage;
```

Defined in: [shared/src/cache.ts:48](https://github.com/databricks/appkit/blob/main/packages/shared/src/cache.ts#L48)

Cache Storage provider instance

***

### strictPersistence?

```ts
optional strictPersistence: boolean;
```

Defined in: [shared/src/cache.ts:50](https://github.com/databricks/appkit/blob/main/packages/shared/src/cache.ts#L50)

Whether to enforce strict persistence

***

### telemetry?

```ts
optional telemetry: TelemetryOptions;
```

Defined in: [shared/src/cache.ts:52](https://github.com/databricks/appkit/blob/main/packages/shared/src/cache.ts#L52)

Telemetry configuration

***

### ttl?

```ts
optional ttl: number;
```

Defined in: [shared/src/cache.ts:40](https://github.com/databricks/appkit/blob/main/packages/shared/src/cache.ts#L40)

Time to live in seconds
