---
sidebar_position: 9
---

# AI Search plugin

<!-- AUTO-GENERATED: stability-banner-start -->
:::warning Beta plugin
This plugin is currently **beta**. APIs may change between minor releases. Import from `@databricks/appkit/beta`. See [Plugin Stability Tiers](./stability.md).
:::
<!-- AUTO-GENERATED: stability-banner-end -->

Query Databricks Vector Search indexes with hybrid search, reranking, and cursor pagination from your AppKit application.

**Key features:**
- Named index aliases for multiple Vector Search indexes
- Hybrid, ANN, and full-text query modes
- Optional reranking with column-level control
- Cursor-based pagination for large result sets
- Service principal (default) and on-behalf-of-user auth
- Self-managed embedding indexes via custom `embeddingFn`

## Basic usage

```ts
import { createApp, server } from "@databricks/appkit";
import { aiSearch } from "@databricks/appkit/beta";

await createApp({
  plugins: [
    server(),
    aiSearch({
      indexes: {
        products: {
          indexName: "catalog.schema.products_idx",
          columns: ["id", "name", "description"],
          queryType: "hybrid",
          numResults: 20,
        },
      },
    }),
  ],
});
```

## Configuration options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `indexes` | `Record<string, IndexConfig>` | — | **Required.** Map of alias names to index configurations |
| `timeout` | `number` | `30000` | Query timeout in ms |

### Index aliases

Index aliases let you reference multiple Vector Search indexes by name. The alias is used in API routes and programmatic calls:

```ts
aiSearch({
  indexes: {
    products: {
      indexName: "catalog.schema.products_idx",
      columns: ["id", "name", "description"],
    },
    docs: {
      indexName: "catalog.schema.docs_idx",
      columns: ["id", "title", "content", "url"],
      queryType: "full_text",
    },
  },
});
```

## IndexConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `indexName` | `string` | `DATABRICKS_VS_INDEX_NAME` | Three-level Unity Catalog name (`catalog.schema.index`). Defaults to the `DATABRICKS_VS_INDEX_NAME` env var when omitted. |
| `columns` | `string[]` | auto-discovered in dev | Columns to return in query results. Optional in development — when omitted, the plugin reads them from the index's source table and warns. **Set explicitly for production**, where a missing value is not auto-filled. |
| `queryType` | `"ann" \| "hybrid" \| "full_text"` | `"hybrid"` | Search mode |
| `numResults` | `number` | `20` | Maximum results per query |
| `reranker` | `boolean \| { columnsToRerank: string[] }` | — | Enable reranking. Pass `true` to rerank all result columns, or specify a subset |
| `auth` | `"service-principal" \| "on-behalf-of-user"` | `"service-principal"` | Authentication mode for query execution |
| `pagination` | `boolean` | — | Enable cursor-based pagination |
| `endpointName` | `string` | — | Vector Search endpoint name. Required when `pagination` is `true` |
| `embeddingFn` | `(text: string) => Promise<number[]>` | — | Custom embedding function for self-managed embedding indexes |

### Query types

- **`hybrid`** — Combines vector similarity and keyword search. Best for general-purpose retrieval.
- **`ann`** — Approximate nearest neighbor search using embeddings only. Best for semantic similarity.
- **`full_text`** — Keyword-based search with no embedding required.

### Reranking

Reranking improves result relevance by running a second-stage model over the initial candidates:

```ts
aiSearch({
  indexes: {
    products: {
      indexName: "catalog.schema.products_idx",
      columns: ["id", "name", "description", "category"],
      reranker: { columnsToRerank: ["name", "description"] },
    },
  },
});
```

Pass `reranker: true` to rerank across all returned columns.

### On-behalf-of-user auth

By default, queries run as the app's service principal. Set `auth: "on-behalf-of-user"` to execute queries as the signed-in user instead:

```ts
aiSearch({
  indexes: {
    documents: {
      indexName: "catalog.schema.documents_idx",
      columns: ["id", "title", "body"],
      auth: "on-behalf-of-user",
    },
  },
});
```

### Pagination

Enable cursor pagination to page through large result sets:

```ts
aiSearch({
  indexes: {
    products: {
      indexName: "catalog.schema.products_idx",
      columns: ["id", "name", "description"],
      pagination: true,
      endpointName: "my-vector-search-endpoint",
    },
  },
});
```

`endpointName` is required when `pagination` is `true`. Use the `/:alias/next-page` route to fetch subsequent pages.

### Self-managed embedding indexes

For indexes that manage their own embeddings, provide an `embeddingFn` that takes a query string and returns a vector:

```ts
import { embed } from "./my-embedding-client";

aiSearch({
  indexes: {
    products: {
      indexName: "catalog.schema.products_idx",
      columns: ["id", "name", "description"],
      queryType: "ann",
      embeddingFn: (text) => embed(text),
    },
  },
});
```

## HTTP routes

Routes are mounted at `/api/ai-search`.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/:alias/query` | Query an index by alias |
| `POST` | `/:alias/next-page` | Fetch the next page of results (requires `pagination: true`) |
| `GET` | `/:alias/config` | Return the resolved config for an index alias |

### Query an index

```
POST /api/ai-search/:alias/query
Content-Type: application/json

{
  "queryText": "machine learning guide",
  "numResults": 10
}
```

Response:

```json
{
  "results": [
    {
      "score": 0.87,
      "data": { "id": "42", "name": "Intro to ML", "description": "..." }
    }
  ],
  "totalCount": 1,
  "queryTimeMs": 35,
  "queryType": "hybrid",
  "nextPageToken": "eyJvZmZzZXQiOjEwfQ=="
}
```

Each result carries its relevance `score` and the returned columns under `data`. `nextPageToken` is `null` unless `pagination` is enabled and more results are available.

### Fetch the next page

```
POST /api/ai-search/:alias/next-page
Content-Type: application/json

{
  "queryText": "machine learning guide",
  "pageToken": "eyJvZmZzZXQiOjEwfQ=="
}
```

### Get index config

```
GET /api/ai-search/:alias/config
```

Returns the resolved `IndexConfig` for the alias (excluding `embeddingFn`).

## Programmatic access

The plugin exposes a `query` method for server-side use:

```ts
import { createApp, server } from "@databricks/appkit";
import { aiSearch } from "@databricks/appkit/beta";

const AppKit = await createApp({
  plugins: [
    server(),
    aiSearch({
      indexes: {
        products: {
          indexName: "catalog.schema.products_idx",
          columns: ["id", "name", "description"],
        },
      },
    }),
  ],
});

const result = await AppKit.aiSearch.query("products", {
  queryText: "machine learning guide",
});

console.log(result.results);
```

Pass optional overrides as a second argument to `query` to adjust `numResults` or other per-call settings.
