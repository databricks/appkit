# Type Alias: ResourcePermission

```ts
type ResourcePermission = 
  | SecretPermission
  | JobPermission
  | SqlWarehousePermission
  | ServingEndpointPermission
  | VolumePermission
  | VectorSearchIndexPermission
  | UcFunctionPermission
  | UcConnectionPermission
  | DatabasePermission
  | GenieSpacePermission
  | ExperimentPermission
  | AppPermission;
```

Union of all possible permission levels across all resource types.
