# @databricks/appkit-vector-search

Appkit plugin that adds Databricks Vector Search to your app — backend routes, React hook, and UI components in one package.

## Quick Start

**Backend** (`app.ts`):

```typescript
import { createApp } from '@databricks/appkit';
import { VectorSearchPlugin } from '@databricks/appkit-vector-search';

createApp({
  plugins: [
    new VectorSearchPlugin({
      indexes: {
        products: {
          indexName: 'catalog.schema.product_index',
          columns: ['id', 'name', 'description', 'price', 'category'],
        },
      },
    }),
  ],
});
```

**Frontend** (`ProductSearch.tsx`):

```tsx
import { useVectorSearch, SearchBox, SearchResults } from '@databricks/appkit-vector-search';

function ProductSearch() {
  const vs = useVectorSearch<{ id: string; name: string; description: string; price: number; category: string }>('products');

  return (
    <div className="mx-auto max-w-4xl p-6">
      <SearchBox onSearch={vs.search} isLoading={vs.isLoading} placeholder="Search products..." autoFocus />
      <SearchResults
        results={vs.results} isLoading={vs.isLoading} error={vs.error}
        query={vs.query} totalCount={vs.totalCount} queryTimeMs={vs.queryTimeMs}
        titleColumn="name" descriptionColumn="description"
        displayColumns={['price', 'category']} showScores
      />
    </div>
  );
}
```

That's it — hybrid search with debouncing, loading states, keyword highlighting, and error handling.

## Installation

```bash
npm install @databricks/appkit-vector-search
```

Peer dependencies: `react ^18.x`, `@databricks/appkit ^0.x`.

## Backend Setup

Register the plugin with `createApp`. Each key in `indexes` is an **alias** used by the frontend hook and API routes.

```typescript
new VectorSearchPlugin({
  indexes: {
    products: {
      indexName: 'catalog.schema.product_index',  // required — three-level UC name
      columns: ['id', 'name', 'description'],     // required — columns to return
      queryType: 'hybrid',                         // 'ann' | 'hybrid' | 'full_text' (default: 'hybrid')
      numResults: 20,                              // max results per query (default: 20)
      reranker: false,                             // enable Databricks reranker (default: false)
      auth: 'service-principal',                   // 'service-principal' | 'on-behalf-of-user' (default: 'service-principal')
      cache: { enabled: false },                   // see Caching section
      pagination: false,                           // see Pagination section
      endpointName: 'my-endpoint',                 // required when pagination: true
      embeddingFn: undefined,                      // see Self-Managed Embeddings section
    },
  },
})
```

### IndexConfig Reference

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `indexName` | `string` | *required* | Three-level UC name (`catalog.schema.index`) |
| `columns` | `string[]` | *required* | Columns to return in results |
| `queryType` | `'ann' \| 'hybrid' \| 'full_text'` | `'hybrid'` | Default search mode |
| `numResults` | `number` | `20` | Max results per query |
| `reranker` | `boolean \| { columnsToRerank: string[] }` | `false` | Enable built-in reranker |
| `auth` | `'service-principal' \| 'on-behalf-of-user'` | `'service-principal'` | Auth mode |
| `cache` | `CacheConfig` | `undefined` | Optional result caching |
| `pagination` | `boolean` | `false` | Enable cursor pagination |
| `endpointName` | `string` | `undefined` | VS endpoint name (required if `pagination: true`) |
| `embeddingFn` | `(text: string) => Promise<number[]>` | `undefined` | Custom embedding function for self-managed indexes |

## Frontend

### `useVectorSearch` Hook

```typescript
const vs = useVectorSearch<Product>('products', {
  debounceMs: 300,       // debounce delay (default: 300)
  numResults: 10,        // override server default
  queryType: 'ann',      // override server default
  reranker: true,        // override server default
  minQueryLength: 2,     // minimum chars before searching (default: 1)
  initialFilters: { category: 'electronics' },
  onResults: (response) => console.log(response),
  onError: (error) => console.error(error),
});
```

**Returns:**

| Property | Type | Description |
|----------|------|-------------|
| `search` | `(query: string) => void` | Execute a search (debounced) |
| `results` | `SearchResult<T>[]` | Current results (each has `.score` and `.data`) |
| `isLoading` | `boolean` | Whether a search is in flight |
| `error` | `SearchError \| null` | Error from last search |
| `query` | `string` | Current query text |
| `totalCount` | `number` | Total result count |
| `queryTimeMs` | `number` | Query execution time in ms |
| `fromCache` | `boolean` | Whether results came from cache |
| `setFilters` | `(filters) => void` | Set filters and re-execute search |
| `activeFilters` | `SearchFilters` | Current active filters |
| `clear` | `() => void` | Clear query, results, and filters |
| `hasMore` | `boolean` | More results available (pagination) |
| `loadMore` | `() => void` | Fetch next page, append to results |
| `isLoadingMore` | `boolean` | Whether loadMore is in flight |

The hook handles debouncing, request cancellation (AbortController), filter reactivity, and cleanup on unmount.

### Components

#### `<SearchBox>`

```tsx
<SearchBox
  onSearch={vs.search}       // required — called on every keystroke
  value={vs.query}           // controlled mode (optional — uncontrolled by default)
  isLoading={vs.isLoading}   // shows spinner (default: false)
  placeholder="Search..."   // input placeholder (default: "Search...")
  autoFocus={true}           // focus on mount (default: false)
  className="w-full"         // additional CSS classes
/>
```

Includes search icon, clear button (appears when input has value), Escape key to clear, and loading spinner.

#### `<SearchResults>`

```tsx
<SearchResults
  results={vs.results}               // required
  isLoading={vs.isLoading}           // required — shows skeleton loader
  error={vs.error}                   // required — shows error banner
  query={vs.query}                   // required — controls empty state
  totalCount={vs.totalCount}         // required — shown in summary
  queryTimeMs={vs.queryTimeMs}       // required — shown in summary
  titleColumn="name"                 // column to render as card title
  descriptionColumn="description"    // column to render as card description
  displayColumns={['price', 'category']}  // additional columns as key-value metadata
  showScores={true}                  // show relevance percentage badge (default: false)
  emptyMessage="No results found."   // custom empty state message
  renderResult={(result, i) => ...}  // fully custom result rendering (overrides default card)
  className="mt-4"
/>
```

States: loading skeleton (3 animated cards), error banner, empty message, results with count + timing.

#### `<SearchResultCard>`

Used internally by `SearchResults`, but can be used standalone:

```tsx
<SearchResultCard
  result={result}                    // required — { score, data }
  titleColumn="name"                 // column for card title
  descriptionColumn="description"    // column for card description (2-line clamp)
  displayColumns={['price']}         // additional metadata as key-value pairs
  showScore={true}                   // show relevance badge (default: false)
  query="wireless headphones"        // query string for keyword highlighting
/>
```

#### `<SearchLoadMore>`

```tsx
<SearchLoadMore
  hasMore={vs.hasMore}         // required — hides button when false
  isLoading={vs.isLoadingMore} // required — shows "Loading..." when true
  onLoadMore={vs.loadMore}     // required
  className="mt-4"
/>
```

### Filters

Use `setFilters` from the hook to apply VS filter syntax:

```typescript
// IN list
vs.setFilters({ category: ['electronics', 'books'] });

// Comparison operators
vs.setFilters({ 'price >=': 10, 'price <=': 100 });

// NOT
vs.setFilters({ 'title NOT': 'test' });

// LIKE
vs.setFilters({ 'name LIKE': 'data%' });

// OR across columns
vs.setFilters({ 'color1 OR color2': ['red', 'blue'] });
```

Calling `setFilters` immediately re-executes the current search with the new filters.

## Auth

### Service Principal (default)

The plugin uses `DATABRICKS_CLIENT_ID` and `DATABRICKS_CLIENT_SECRET` from the environment. When deployed to Databricks Apps, these are set automatically. OAuth tokens are cached and refreshed with a 2-minute buffer before expiry.

No configuration needed — this is the default.

### On-Behalf-of-User

For indexes with row-level security or Unity Catalog permissions:

```typescript
indexes: {
  docs: {
    indexName: 'catalog.schema.docs_index',
    columns: ['id', 'title', 'content'],
    auth: 'on-behalf-of-user',  // uses the logged-in user's token
  },
}
```

The plugin extracts the user's OAuth token from the `x-forwarded-access-token` header (set by Databricks Apps proxy). Queries run with the user's identity and UC permissions.

## Self-Managed Embeddings

For indexes that don't use Databricks-managed embeddings, provide an `embeddingFn` that converts query text to a vector:

```typescript
indexes: {
  custom: {
    indexName: 'catalog.schema.custom_index',
    columns: ['id', 'title', 'content'],
    queryType: 'ann',
    embeddingFn: async (text) => {
      const resp = await fetch(
        `https://${process.env.DATABRICKS_HOST}/serving-endpoints/my-embedding-model/invocations`,
        {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: [text] }),
        },
      );
      const data = await resp.json();
      return data.data[0].embedding;
    },
  },
}
```

When `embeddingFn` is set, the plugin calls it to convert `queryText` into `queryVector` before sending to VS. The frontend hook works identically — users type text, the backend handles the conversion.

If omitted, the plugin sends `queryText` directly and VS computes embeddings server-side (managed mode).

## Caching

Optional LRU cache for search results. Off by default (freeform search has low cache hit rates).

```typescript
indexes: {
  products: {
    indexName: 'catalog.schema.product_index',
    columns: ['id', 'name', 'description'],
    cache: {
      enabled: true,
      ttlSeconds: 120,   // time-to-live per entry (default: 60)
      maxEntries: 1000,   // max cached queries (default: 1000)
    },
  },
}
```

Cached responses include `fromCache: true` in the response. The hook exposes this via `vs.fromCache`.

## Pagination

Cursor-based pagination for large result sets. Off by default — VS typically returns results in 20-40ms, so most apps don't need it.

```typescript
indexes: {
  products: {
    indexName: 'catalog.schema.product_index',
    columns: ['id', 'name', 'description'],
    pagination: true,
    endpointName: 'my-vs-endpoint',  // required when pagination is enabled
  },
}
```

Frontend usage:

```tsx
const vs = useVectorSearch<Product>('products');

return (
  <>
    <SearchBox onSearch={vs.search} isLoading={vs.isLoading} />
    <SearchResults results={vs.results} isLoading={vs.isLoading} error={vs.error}
      query={vs.query} totalCount={vs.totalCount} queryTimeMs={vs.queryTimeMs}
      titleColumn="name" />
    <SearchLoadMore hasMore={vs.hasMore} isLoading={vs.isLoadingMore} onLoadMore={vs.loadMore} />
  </>
);
```

`loadMore` fetches the next page and appends results to the existing array.

## API Reference

The plugin registers these Express routes automatically:

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `POST` | `/api/vector-search/:alias/query` | `SearchRequest` | Execute a search |
| `POST` | `/api/vector-search/:alias/next-page` | `{ pageToken: string }` | Fetch next page (requires `pagination: true`) |
| `GET` | `/api/vector-search/:alias/config` | — | Returns index config (columns, queryType, numResults, etc.) |

### SearchRequest Body

```json
{
  "queryText": "wireless headphones",
  "filters": { "category": ["electronics"] },
  "numResults": 10,
  "queryType": "hybrid",
  "reranker": true
}
```

### SearchResponse

```json
{
  "results": [
    { "score": 0.92, "data": { "id": "1", "name": "...", "description": "..." } }
  ],
  "totalCount": 47,
  "queryTimeMs": 35,
  "queryType": "hybrid",
  "fromCache": false,
  "nextPageToken": null
}
```

### Error Response

```json
{
  "code": "INVALID_QUERY",
  "message": "queryText or queryVector is required",
  "statusCode": 400
}
```

Error codes: `UNAUTHORIZED`, `INDEX_NOT_FOUND`, `INVALID_QUERY`, `RATE_LIMITED`, `INTERNAL`.
