# Function: contentTypeFromPath()

```ts
function contentTypeFromPath(
   filePath: string, 
   reported?: string, 
   customTypes?: Record<string, string>): string;
```

Resolve the MIME content type for a file path.

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `filePath` | `string` | Path to the file (only the extension is inspected). |
| `reported?` | `string` | Optional MIME type reported by the caller; used as fallback when the extension is unknown. |
| `customTypes?` | `Record`\<`string`, `string`\> | Optional map of extension → MIME type overrides (e.g. `{ ".csv": "text/csv" }`). |

## Returns

`string`

The resolved MIME content type string.
