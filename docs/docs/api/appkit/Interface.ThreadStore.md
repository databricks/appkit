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
