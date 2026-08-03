# Interface: IndexConfig

## Properties

### auth?

```ts
optional auth: "service-principal" | "on-behalf-of-user";
```

Auth mode — "service-principal" uses the app's SP, "on-behalf-of-user" proxies the logged-in user's token

***

### columns

```ts
columns: string[];
```

Columns to return in results

***

### embeddingFn()?

```ts
optional embeddingFn: (text: string) => Promise<number[]>;
```

For self-managed embedding indexes: converts query text to an embedding vector.
When provided, the plugin calls this function and sends query_vector to VS.
When omitted, query_text is sent and VS computes embeddings server-side (managed mode).

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `text` | `string` |

#### Returns

`Promise`\<`number`[]\>

***

### endpointName?

```ts
optional endpointName: string;
```

VS endpoint name (required when pagination is true)

***

### indexName

```ts
indexName: string;
```

Three-level UC name: catalog.schema.index_name

***

### numResults?

```ts
optional numResults: number;
```

Max results per query

***

### pagination?

```ts
optional pagination: boolean;
```

Enable cursor pagination

***

### queryType?

```ts
optional queryType: "ann" | "hybrid" | "full_text";
```

Default search mode

***

### reranker?

```ts
optional reranker: boolean | RerankerConfig;
```

Enable built-in reranker. Pass true to rerank all non-id columns, or an object for fine control.
