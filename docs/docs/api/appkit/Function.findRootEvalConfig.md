# Function: findRootEvalConfig()

```ts
function findRootEvalConfig(rootDir: string): string | undefined;
```

Path to the root `evals.config.ts` (from [defineEvalConfig](Function.defineEvalConfig.md)) at
`<rootDir>/evals.config.ts`, or `undefined` when absent. The root config
holds run-wide settings (`baseUrl`, `webServer`); it's distinct from the
per-agent configs found by [discoverEvalConfigs](Function.discoverEvalConfigs.md).

## Parameters

| Parameter | Type |
| ------ | ------ |
| `rootDir` | `string` |

## Returns

`string` \| `undefined`
