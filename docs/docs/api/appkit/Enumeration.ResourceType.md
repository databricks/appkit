# Enumeration: ResourceType

Supported resource types that plugins can depend on.
Each type has its own set of valid permissions.

## Enumeration Members

### APP

```ts
APP: "app";
```

Databricks App dependency

***

### DATABASE

```ts
DATABASE: "database";
```

Database (Lakebase) for persistent storage

***

### EXPERIMENT

```ts
EXPERIMENT: "experiment";
```

MLflow Experiment for ML tracking

***

### GENIE\_SPACE

```ts
GENIE_SPACE: "genie_space";
```

Genie Space for AI assistant

***

### JOB

```ts
JOB: "job";
```

Databricks Job for scheduled or triggered workflows

***

### SECRET

```ts
SECRET: "secret";
```

Secret scope for secure credential storage

***

### SERVING\_ENDPOINT

```ts
SERVING_ENDPOINT: "serving_endpoint";
```

Model serving endpoint for ML inference

***

### SQL\_WAREHOUSE

```ts
SQL_WAREHOUSE: "sql_warehouse";
```

Databricks SQL Warehouse for query execution

***

### UC\_CONNECTION

```ts
UC_CONNECTION: "uc_connection";
```

Unity Catalog Connection for external data sources

***

### UC\_FUNCTION

```ts
UC_FUNCTION: "uc_function";
```

Unity Catalog Function

***

### VECTOR\_SEARCH\_INDEX

```ts
VECTOR_SEARCH_INDEX: "vector_search_index";
```

Vector Search Index for similarity search

***

### VOLUME

```ts
VOLUME: "volume";
```

Unity Catalog Volume for file storage
