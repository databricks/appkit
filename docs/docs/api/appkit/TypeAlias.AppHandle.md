# Type Alias: AppHandle\<U\>

```ts
type AppHandle<U> = PluginMap<U> & {
  [asyncDispose]: Promise<void>;
  close: Promise<void>;
};
```

What `createApp()` returns: every plugin's exports keyed by manifest name,
plus the app's own teardown handle.

`close()` releases what AppKit acquired — sockets, timers, pools, cache, and
telemetry — without terminating the process, so a host can embed AppKit and a
test can boot more than once in a file.

`Symbol.asyncDispose` is exposed alongside it because a plugin's manifest name
can never be a symbol: `await using app = await createApp(...)` is safe even
if a plugin were somehow named `close`.

## Type Declaration

### \[asyncDispose\]()

```ts
asyncDispose: Promise<void>;
```

#### Returns

`Promise`\<`void`\>

### close()

```ts
close(options?: {
  timeoutMs?: number;
}): Promise<void>;
```

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options?` | \{ `timeoutMs?`: `number`; \} | - |
| `options.timeoutMs?` | `number` | Overall teardown budget. Defaults to AppKit's programmatic budget, which is shorter than the signal path's. |

#### Returns

`Promise`\<`void`\>

## Type Parameters

| Type Parameter |
| ------ |
| `U` *extends* readonly [`PluginData`](TypeAlias.PluginData.md)\<`PluginConstructor`, `unknown`, `string`\>[] |
