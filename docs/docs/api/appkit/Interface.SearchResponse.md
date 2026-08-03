# Interface: SearchResponse\<T\>

## Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `T` *extends* `Record`\<`string`, `unknown`\> | `Record`\<`string`, `unknown`\> |

## Properties

### nextPageToken

```ts
nextPageToken: string | null;
```

***

### queryTimeMs

```ts
queryTimeMs: number;
```

***

### queryType

```ts
queryType: "ann" | "hybrid" | "full_text";
```

***

### results

```ts
results: SearchResult<T>[];
```

***

### totalCount

```ts
totalCount: number;
```
