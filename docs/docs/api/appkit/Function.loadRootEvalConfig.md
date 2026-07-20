# Function: loadRootEvalConfig()

```ts
function loadRootEvalConfig(rootDir: string): Promise<EvalConfig | undefined>;
```

Load the root `evals.config.ts` under `rootDir` (the project root), or return
`undefined` when there is none. This is the run-wide config carrying
`baseUrl`/`webServer`; the CLI reads it to resolve options and manage the
app-under-test lifecycle before calling [runEvalsInDir](Function.runEvalsInDir.md).

## Parameters

| Parameter | Type |
| ------ | ------ |
| `rootDir` | `string` |

## Returns

`Promise`\<[`EvalConfig`](Interface.EvalConfig.md) \| `undefined`\>
