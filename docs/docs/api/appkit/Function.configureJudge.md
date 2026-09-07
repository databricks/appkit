# Function: configureJudge()

```ts
function configureJudge(config: JudgeConfig): Promise<void>;
```

Configure the judge once. Sets the OpenAI-compatible client env autoevals
reads and the default judge model. No-op-safe: on failure, judging stays
disabled and [isJudgeConfigured](Function.isJudgeConfigured.md) returns false.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `config` | [`JudgeConfig`](Interface.JudgeConfig.md) |

## Returns

`Promise`\<`void`\>
