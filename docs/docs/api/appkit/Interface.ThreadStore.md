# Interface: ThreadStore

## Methods

### addMessage()

```ts
addMessage(
   threadId: string, 
   userId: string, 
message: Message): Promise<void>;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `threadId` | `string` |
| `userId` | `string` |
| `message` | [`Message`](Interface.Message.md) |

#### Returns

`Promise`\<`void`\>

***

### close()?

```ts
optional close(): Promise<void>;
```

Optional teardown — e.g. close an owned connection pool. Called during
agents-plugin shutdown. In-memory stores omit it.

#### Returns

`Promise`\<`void`\>

***

### create()

```ts
create(userId: string): Promise<Thread>;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `userId` | `string` |

#### Returns

`Promise`\<[`Thread`](Interface.Thread.md)\>

***

### delete()

```ts
delete(threadId: string, userId: string): Promise<boolean>;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `threadId` | `string` |
| `userId` | `string` |

#### Returns

`Promise`\<`boolean`\>

***

### get()

```ts
get(threadId: string, userId: string): Promise<Thread | null>;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `threadId` | `string` |
| `userId` | `string` |

#### Returns

`Promise`\<[`Thread`](Interface.Thread.md) \| `null`\>

***

### init()?

```ts
optional init(): Promise<void>;
```

Optional one-time initialization — e.g. verify connectivity and bootstrap
a backing schema. Called once during agents-plugin setup, so a failure
here fails boot fast. In-memory stores omit it.

#### Returns

`Promise`\<`void`\>

***

### list()

```ts
list(userId: string): Promise<Thread[]>;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `userId` | `string` |

#### Returns

`Promise`\<[`Thread`](Interface.Thread.md)[]\>

***

### listSummaries()?

```ts
optional listSummaries(userId: string): Promise<ThreadSummary[]>;
```

Optional cheap list projection for a history sidebar — summaries only, no
message bodies. When a store omits it, the agents plugin falls back to
deriving summaries from [list](#list) (correct, just heavier).

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `userId` | `string` |

#### Returns

`Promise`\<[`ThreadSummary`](Interface.ThreadSummary.md)[]\>

***

### rename()?

```ts
optional rename(
   threadId: string, 
   userId: string, 
title: string): Promise<boolean>;
```

Optional rename of a thread's title (user-scoped). Returns `false` when no
matching thread exists for the user. When a store omits it, the rename
route reports the operation as unsupported.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `threadId` | `string` |
| `userId` | `string` |
| `title` | `string` |

#### Returns

`Promise`\<`boolean`\>
