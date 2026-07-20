# Function: runBounded()

```ts
function runBounded<T, R>(
   tasks: readonly T[], 
   limit: number, 
worker: (task: T, index: number) => Promise<R>): Promise<R[]>;
```

Run `tasks` through a bounded worker pool and return their results in the
SAME order as the input, regardless of completion order. Each task receives
its input index so callers can key on it. `limit` is clamped to at least 1
(and to the task count); at `limit === 1` this is a serial loop. Individual
task rejections are surfaced per-slot via `settle` rather than aborting
siblings — but eval tasks never reject (failures become results).

## Type Parameters

| Type Parameter |
| ------ |
| `T` |
| `R` |

## Parameters

| Parameter | Type |
| ------ | ------ |
| `tasks` | readonly `T`[] |
| `limit` | `number` |
| `worker` | (`task`: `T`, `index`: `number`) => `Promise`\<`R`\> |

## Returns

`Promise`\<`R`[]\>
