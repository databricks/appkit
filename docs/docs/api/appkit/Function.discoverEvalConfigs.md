# Function: discoverEvalConfigs()

```ts
function discoverEvalConfigs(rootDir: string): DiscoveredEvalConfig[];
```

Discover the per-agent `evals.config.ts` (from [defineEvalConfig](Function.defineEvalConfig.md)) at
`<rootDir>/server/agents/<agent>/evals/evals.config.ts`. Config is per-agent:
each agent's config applies only to that agent's evals. Agents without a
config file are omitted. Returns a stable, sorted list.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `rootDir` | `string` |

## Returns

[`DiscoveredEvalConfig`](Interface.DiscoveredEvalConfig.md)[]
