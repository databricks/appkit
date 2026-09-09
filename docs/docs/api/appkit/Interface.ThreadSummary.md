# Interface: ThreadSummary

Lightweight thread projection for a history list — no message bodies, so a
sidebar of many threads stays cheap. `title` is already resolved (explicit
rename, else derived from the first user message; may be empty when neither
exists). Returned by [ThreadStore.listSummaries](Interface.ThreadStore.md#listsummaries).

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

### messageCount

```ts
messageCount: number;
```

***

### title

```ts
title: string;
```

***

### updatedAt

```ts
updatedAt: Date;
```
