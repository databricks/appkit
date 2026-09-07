# Function: discoverEvalFiles()

```ts
function discoverEvalFiles(rootDir: string): DiscoveredEval[];
```

Discover evals under `<rootDir>/server/agents/<agent>/evals/` — co-located
with each agent's `agent.{md,ts}` (same folder-per-agent layout the agents
plugin discovers). The agent id is the folder name; the eval id is the file
path relative to that evals dir with `.eval.ts` stripped. Sorted + stable.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `rootDir` | `string` |

## Returns

[`DiscoveredEval`](Interface.DiscoveredEval.md)[]
