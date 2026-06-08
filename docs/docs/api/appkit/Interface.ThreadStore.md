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
