# Interface: RequestedClaims

Optional claims for fine-grained Unity Catalog table permissions
When specified, the returned token will be scoped to only the requested tables

## Properties

### permission\_set?

```ts
optional permission_set: READ_ONLY;
```

Permission level to request

***

### resources?

```ts
optional resources: RequestedResource[];
```

List of UC resources to request access to
