# Class: LakebaseThreadStore

Persistent [ThreadStore](Interface.ThreadStore.md) backed by Databricks Lakebase (Postgres).

Threads and messages live in two `user_id`-scoped tables (`agent_threads`,
`agent_messages`, FK cascade). The app service principal owns the tables;
**every** query filters `WHERE user_id = $` — that is the isolation
boundary, so a user can never read or mutate another user's threads.

The schema is self-bootstrapping: [init](#init) issues idempotent
`CREATE TABLE IF NOT EXISTS` (once-guarded) and verifies connectivity, so
a fresh Lakebase database works with no migration step.

Pass it to the agents plugin for a deployment that survives restarts:
```ts
agents({ threadStore: new LakebaseThreadStore() })
```

## Implements

- [`ThreadStore`](Interface.ThreadStore.md)

## Constructors

### Constructor

```ts
new LakebaseThreadStore(__namedParameters: LakebaseThreadStoreOptions): LakebaseThreadStore;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `__namedParameters` | [`LakebaseThreadStoreOptions`](Interface.LakebaseThreadStoreOptions.md) |

#### Returns

`LakebaseThreadStore`

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

#### Implementation of

[`ThreadStore`](Interface.ThreadStore.md).[`addMessage`](Interface.ThreadStore.md#addmessage)

***

### close()

```ts
close(): Promise<void>;
```

Close the pool only when this store created it.

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`ThreadStore`](Interface.ThreadStore.md).[`close`](Interface.ThreadStore.md#close)

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

#### Implementation of

[`ThreadStore`](Interface.ThreadStore.md).[`create`](Interface.ThreadStore.md#create)

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

#### Implementation of

[`ThreadStore`](Interface.ThreadStore.md).[`delete`](Interface.ThreadStore.md#delete)

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

#### Implementation of

[`ThreadStore`](Interface.ThreadStore.md).[`get`](Interface.ThreadStore.md#get)

***

### init()

```ts
init(): Promise<void>;
```

Verify connectivity and create the tables once (idempotent).

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`ThreadStore`](Interface.ThreadStore.md).[`init`](Interface.ThreadStore.md#init)

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

#### Implementation of

[`ThreadStore`](Interface.ThreadStore.md).[`list`](Interface.ThreadStore.md#list)

***

### listSummaries()

```ts
listSummaries(userId: string): Promise<ThreadSummary[]>;
```

Optional cheap list projection for a history sidebar — summaries only, no
message bodies. When a store omits it, the agents plugin falls back to
deriving summaries from [list](Interface.ThreadStore.md#list) (correct, just heavier).

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `userId` | `string` |

#### Returns

`Promise`\<[`ThreadSummary`](Interface.ThreadSummary.md)[]\>

#### Implementation of

[`ThreadStore`](Interface.ThreadStore.md).[`listSummaries`](Interface.ThreadStore.md#listsummaries)

***

### rename()

```ts
rename(
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

#### Implementation of

[`ThreadStore`](Interface.ThreadStore.md).[`rename`](Interface.ThreadStore.md#rename)
