# Function: contentTypeFromPath()

```ts
function contentTypeFromPath(
   filePath: string, 
   reported?: string, 
   customTypes?: Record<string, string>): string;
```

Resolve the MIME content type for a file path.

Resolution order:
1. Custom type map (if the extension matches a key in `customTypes`).
2. Built-in extension map (EXTENSION\_CONTENT\_TYPES).
3. The `reported` type from the server, or `application/octet-stream` as a fallback.

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `filePath` | `string` | File path used to extract the extension. |
| `reported?` | `string` | Content type reported by the server (used as fallback). |
| `customTypes?` | `Record`\<`string`, `string`\> | Optional map of extensions to MIME types that takes priority. |

## Returns

`string`

The resolved MIME content type string.
