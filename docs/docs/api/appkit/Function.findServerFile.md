# Function: findServerFile()

```ts
function findServerFile(basePath: string): string | null;
```

Find the server entry file by checking candidate paths in order.

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `basePath` | `string` | Project root directory to search from |

## Returns

`string` \| `null`

Absolute path to the server file, or null if none found
