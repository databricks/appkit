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
