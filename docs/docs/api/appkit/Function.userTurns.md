# Function: userTurns()

```ts
function userTurns(input: Record<string, unknown>): string[];
```

Extract every user-message content, in order, from an MLflow
`{"messages":[{"role":"user","content":"..."}]}` input. A dataset row can
carry a full multi-turn conversation; replaying these against one thread (one
`t.send` per returned string) lets the agent see the accumulating history.

Only `role === "user"` turns are returned — any interleaved `assistant`/
`system` messages in the row are ignored, since the agent generates its own
responses; you never inject the dataset's assistant turns. A single-user-turn
row yields a one-element array (backward compatible); a row with no `messages`
yields `[]`.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `input` | `Record`\<`string`, `unknown`\> |

## Returns

`string`[]
