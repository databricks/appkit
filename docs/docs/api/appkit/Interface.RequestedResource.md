# Interface: RequestedResource

Resource to request permissions for in Unity Catalog

## Properties

### table\_name?

```ts
optional table_name: string;
```

Unity Catalog table name to request access to

#### Example

```ts
"catalog.schema.table"
```

***

### unspecified\_resource\_name?

```ts
optional unspecified_resource_name: string;
```

Generic resource name for non-table resources
