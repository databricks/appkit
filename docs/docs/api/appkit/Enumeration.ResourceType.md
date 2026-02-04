# Enumeration: ResourceType

Supported resource types that plugins can depend on.

## Enumeration Members

### JOB

```ts
JOB: "job";
```

Databricks Job for scheduled or triggered workflows

***

### LAKEBASE

```ts
LAKEBASE: "lakebase";
```

Lakebase instance for persistent caching or data storage

***

### SECRET\_SCOPE

```ts
SECRET_SCOPE: "secret-scope";
```

Secret scope for secure credential storage

***

### SERVING\_ENDPOINT

```ts
SERVING_ENDPOINT: "serving-endpoint";
```

Model serving endpoint for ML inference

***

### SQL\_WAREHOUSE

```ts
SQL_WAREHOUSE: "sql-warehouse";
```

Databricks SQL Warehouse for query execution

***

### UNITY\_CATALOG

```ts
UNITY_CATALOG: "unity-catalog";
```

Unity Catalog for data governance and metadata

***

### VECTOR\_SEARCH\_INDEX

```ts
VECTOR_SEARCH_INDEX: "vector-search-index";
```

Vector search index for similarity search
