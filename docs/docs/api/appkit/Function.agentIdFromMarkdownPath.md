# Function: agentIdFromMarkdownPath()

```ts
function agentIdFromMarkdownPath(filePath: string): string;
```

Derives the logical agent id from a markdown path. When the file is named
`agent.md`, the id is the parent directory name (folder-based layout);
otherwise the id is the file stem (e.g. legacy single-file paths).

## Parameters

| Parameter | Type |
| ------ | ------ |
| `filePath` | `string` |

## Returns

`string`
