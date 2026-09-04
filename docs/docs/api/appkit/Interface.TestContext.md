# Interface: TestContext

The `t` context passed to an eval's `test` function.

## Properties

### expected

```ts
readonly expected: Record<string, unknown> | undefined;
```

The current dataset row's `expectations` (ground truth / guidelines), or
`undefined` when the row has none or the eval isn't dataset-driven.

***

### input

```ts
readonly input: Record<string, unknown>;
```

The current dataset row's `inputs` when the eval is dataset-driven (see
[EvalDefinition.dataset](Interface.EvalDefinition.md#dataset)); `{}` for a plain single-run eval.

***

### judge

```ts
judge: {
  closedQA: Promise<AssertionHandle>;
  custom: Promise<AssertionHandle>;
  factuality: Promise<AssertionHandle>;
};
```

LLM-as-judge scoring of the last reply (via autoevals → a Databricks judge
model). Each returns a scored assertion that gates by default (a miss fails
the eval); chain `.atLeast(n)` to change the pass threshold or `.soft()` to
demote to a tracked-only metric. Requires the judge to be configured
(`--judge-model`).

#### closedQA()

```ts
closedQA(criteria: string): Promise<AssertionHandle>;
```

Score whether the reply answers the question, per optional `criteria`.

##### Parameters

| Parameter | Type |
| ------ | ------ |
| `criteria` | `string` |

##### Returns

`Promise`\<[`AssertionHandle`](Interface.AssertionHandle.md)\>

#### custom()

```ts
custom(spec: CustomJudgeSpec): Promise<AssertionHandle>;
```

A custom prompt-template judge (the TS analog of MLflow's `@scorer`).

##### Parameters

| Parameter | Type |
| ------ | ------ |
| `spec` | [`CustomJudgeSpec`](Interface.CustomJudgeSpec.md) |

##### Returns

`Promise`\<[`AssertionHandle`](Interface.AssertionHandle.md)\>

#### factuality()

```ts
factuality(expected: string): Promise<AssertionHandle>;
```

Score factuality of the reply against an expected reference.

##### Parameters

| Parameter | Type |
| ------ | ------ |
| `expected` | `string` |

##### Returns

`Promise`\<[`AssertionHandle`](Interface.AssertionHandle.md)\>

***

### reply

```ts
readonly reply: string;
```

The last assistant reply.

***

### sessionId

```ts
readonly sessionId: string | undefined;
```

The current session/thread id, if any.

***

### toolCalls

```ts
readonly toolCalls: string[];
```

Tools called during the last turn.

## Methods

### calledTool()

```ts
calledTool(name: string): AssertionHandle;
```

Assert a tool was called during the run (gate by default).

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `name` | `string` |

#### Returns

[`AssertionHandle`](Interface.AssertionHandle.md)

***

### calledToolWith()

```ts
calledToolWith(name: string, expected: Record<string, unknown>): AssertionHandle;
```

Assert a tool was called with arguments that deep-contain `expected`: every
key in `expected` must equal the actual argument (recursively for nested
objects), so extra arguments are ignored. Gate by default.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `name` | `string` |
| `expected` | `Record`\<`string`, `unknown`\> |

#### Returns

[`AssertionHandle`](Interface.AssertionHandle.md)

***

### check()

```ts
check(value: string, matcher: Matcher): AssertionHandle;
```

Assert a value against a matcher, e.g. `t.check(t.reply, includes("Sunny"))`.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `string` |
| `matcher` | [`Matcher`](TypeAlias.Matcher.md) |

#### Returns

[`AssertionHandle`](Interface.AssertionHandle.md)

***

### reset()

```ts
reset(): void;
```

Start a fresh conversation: the next `send` opens a new thread with no
history. Use to run several independent one-shot checks in one test.
Consecutive `send`s (without a `reset`) stay in one multi-turn conversation.

#### Returns

`void`

***

### send()

```ts
send(message: string): Promise<void>;
```

Send a user message to the agent and capture its response.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `message` | `string` |

#### Returns

`Promise`\<`void`\>

***

### skip()

```ts
skip(reason?: string): never;
```

Skip this eval with an optional reason.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `reason?` | `string` |

#### Returns

`never`

***

### succeeded()

```ts
succeeded(): AssertionHandle;
```

Assert the last turn completed successfully (gate by default).

#### Returns

[`AssertionHandle`](Interface.AssertionHandle.md)
