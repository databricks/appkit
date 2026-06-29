# Function: discoverEvalFiles()

```ts
function discoverEvalFiles(rootDir: string): DiscoveredEval[];
```

Discover evals under `<rootDir>/config/agents/<agent>/evals/`. The agent id
is the directory name; the eval id is the file path relative to that evals
dir with `.eval.ts` stripped. Returns a stable, sorted list.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `rootDir` | `string` |

## Returns

[`DiscoveredEval`](Interface.DiscoveredEval.md)[]
