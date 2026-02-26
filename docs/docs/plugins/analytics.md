---
sidebar_position: 3
---

# Analytics plugin

Enables SQL query execution against Databricks SQL Warehouses.

**Key features:**
- File-based SQL queries with automatic type generation
- Parameterized queries with type-safe [SQL helpers](../api/appkit/Variable.sql.md)
- JSON and Arrow format support
- Built-in caching and retry logic
- Server-Sent Events (SSE) streaming

## Basic usage

```ts
import { analytics, createApp, server } from "@databricks/appkit";

await createApp({
  plugins: [server(), analytics({})],
});
```

## Where queries live

- Put `.sql` files in `config/queries/`
- Query key is the filename without `.sql` (e.g. `spend_summary.sql` → `"spend_summary"`)

## SQL parameters

Use `:paramName` placeholders and optionally annotate parameter types using SQL comments:

```sql
-- @param startDate DATE
-- @param endDate DATE
-- @param limit NUMERIC
SELECT ...
WHERE usage_date BETWEEN :startDate AND :endDate
LIMIT :limit
```

**Supported `-- @param` types** (case-insensitive):
- `STRING`, `NUMERIC`, `BOOLEAN`, `DATE`, `TIMESTAMP`, `BINARY`

## Server-injected parameters

`:workspaceId` is **injected by the server** and **must not** be annotated:

```sql
WHERE workspace_id = :workspaceId
```

## HTTP endpoints

The analytics plugin exposes these endpoints (mounted under `/api/analytics`):

- `POST /api/analytics/query/:query_key`
- `GET /api/analytics/arrow-result/:jobId`

## Format options

- `format: "JSON"` (default) returns JSON rows
- `format: "ARROW"` returns an Arrow "statement_id" payload over SSE, then the client fetches binary Arrow from `/api/analytics/arrow-result/:jobId`
