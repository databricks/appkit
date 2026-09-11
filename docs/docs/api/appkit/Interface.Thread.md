# Interface: Thread

## Properties

### createdAt

```ts
createdAt: Date;
```

***

### id

```ts
id: string;
```

***

### messages

```ts
messages: Message[];
```

***

### title?

```ts
optional title: string;
```

Optional human title. Defaults to a value derived from the first user
message (see [ThreadStore.listSummaries](Interface.ThreadStore.md#listsummaries)); an explicit rename via
[ThreadStore.rename](Interface.ThreadStore.md#rename) takes precedence. Undefined until renamed.

***

### updatedAt

```ts
updatedAt: Date;
```

***

### userId

```ts
userId: string;
```
