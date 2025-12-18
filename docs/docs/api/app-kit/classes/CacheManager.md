# Class: CacheManager

Defined in: [app-kit/src/cache/index.ts:24](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/cache/index.ts#L24)

Cache manager class to handle cache operations.
Can be used with in-memory storage or persistent storage (Lakebase).

The cache is automatically initialized by AppKit. Use `getInstanceSync()` to access
the singleton instance after initialization.

## Example

```typescript
const cache = CacheManager.getInstanceSync();
const result = await cache.getOrExecute(["users", userId], () => fetchUser(userId), userKey);
```

## Methods

### clear()

```ts
clear(): Promise<void>;
```

Defined in: [app-kit/src/cache/index.ts:359](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/cache/index.ts#L359)

Clear the cache

#### Returns

`Promise`\<`void`\>

***

### close()

```ts
close(): Promise<void>;
```

Defined in: [app-kit/src/cache/index.ts:395](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/cache/index.ts#L395)

Close the cache

#### Returns

`Promise`\<`void`\>

***

### delete()

```ts
delete(key): Promise<void>;
```

Defined in: [app-kit/src/cache/index.ts:353](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/cache/index.ts#L353)

Delete a value from the cache

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `key` | `string` | Cache key |

#### Returns

`Promise`\<`void`\>

Promise of the result

***

### generateKey()

```ts
generateKey(parts, userKey): string;
```

Defined in: [app-kit/src/cache/index.ts:388](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/cache/index.ts#L388)

Generate a cache key

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `parts` | (`string` \| `number` \| `object`)[] | Parts of the key |
| `userKey` | `string` | User key |

#### Returns

`string`

Cache key

***

### get()

```ts
get<T>(key): Promise<T | null>;
```

Defined in: [app-kit/src/cache/index.ts:288](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/cache/index.ts#L288)

Get a cached value

#### Type Parameters

| Type Parameter |
| ------ |
| `T` |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `key` | `string` | Cache key |

#### Returns

`Promise`\<`T` \| `null`\>

Promise of the value or null if not found or expired

***

### getOrExecute()

```ts
getOrExecute<T>(
   key, 
   fn, 
   userKey, 
options?): Promise<T>;
```

Defined in: [app-kit/src/cache/index.ts:192](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/cache/index.ts#L192)

Get or execute a function and cache the result

#### Type Parameters

| Type Parameter |
| ------ |
| `T` |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `key` | (`string` \| `number` \| `object`)[] | Cache key |
| `fn` | () => `Promise`\<`T`\> | Function to execute |
| `userKey` | `string` | User key |
| `options?` | \{ `ttl?`: `number`; \} | Options for the cache |
| `options.ttl?` | `number` | - |

#### Returns

`Promise`\<`T`\>

Promise of the result

***

### has()

```ts
has(key): Promise<boolean>;
```

Defined in: [app-kit/src/cache/index.ts:369](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/cache/index.ts#L369)

Check if a value exists in the cache

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `key` | `string` | Cache key |

#### Returns

`Promise`\<`boolean`\>

Promise of true if the value exists, false otherwise

***

### isStorageHealthy()

```ts
isStorageHealthy(): Promise<boolean>;
```

Defined in: [app-kit/src/cache/index.ts:403](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/cache/index.ts#L403)

Check if the storage is healthy

#### Returns

`Promise`\<`boolean`\>

Promise of true if the storage is healthy, false otherwise

***

### set()

```ts
set<T>(
   key, 
   value, 
options?): Promise<void>;
```

Defined in: [app-kit/src/cache/index.ts:336](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/cache/index.ts#L336)

Set a value in the cache

#### Type Parameters

| Type Parameter |
| ------ |
| `T` |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `key` | `string` | Cache key |
| `value` | `T` | Value to set |
| `options?` | \{ `ttl?`: `number`; \} | Options for the cache |
| `options.ttl?` | `number` | - |

#### Returns

`Promise`\<`void`\>

Promise of the result

***

### getInstanceSync()

```ts
static getInstanceSync(): CacheManager;
```

Defined in: [app-kit/src/cache/index.ts:72](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/cache/index.ts#L72)

Get the singleton instance of the cache manager (sync version).

Throws if not initialized - ensure AppKit.create() has completed first.

#### Returns

`CacheManager`

CacheManager instance
