# Function: defineEval()

```ts
function defineEval(def: EvalDefinition): EvalDefinition;
```

Define an agent eval. Default-export the result from a
`server/agents/<id>/evals/*.eval.ts` file.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `def` | [`EvalDefinition`](Interface.EvalDefinition.md) |

## Returns

[`EvalDefinition`](Interface.EvalDefinition.md)

## Example

```ts
import { defineEval, includes } from "@databricks/appkit/beta";

export default defineEval({
  description: "Weather agent basic coverage",
  async test(t) {
    await t.send("What's the weather in Brooklyn?");
    t.succeeded();
    t.calledTool("get_weather");
    t.check(t.reply, includes("Sunny"));
  },
});
```
