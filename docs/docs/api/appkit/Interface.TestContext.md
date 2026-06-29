# Interface: TestContext

The `t` context passed to an eval's `test` function.

## Properties

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
