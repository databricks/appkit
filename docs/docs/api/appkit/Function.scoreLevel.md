# Function: scoreLevel()

```ts
function scoreLevel(answer: ScoreAnswer): {
  index: number;
  level: unknown;
};
```

Maps a decide score (a probability-weighted average of level indexes) to
its nearest level, clamped to the legend's range.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `answer` | `ScoreAnswer` |

## Returns

```ts
{
  index: number;
  level: unknown;
}
```

### index

```ts
index: number;
```

### level

```ts
level: unknown;
```
