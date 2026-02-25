# Interface: ValidationResult

Result of validating all registered resources against the environment.

## Properties

### all

```ts
all: ResourceEntry[];
```

Complete list of all registered resources (required and optional)

***

### missing

```ts
missing: ResourceEntry[];
```

List of missing required resources

***

### valid

```ts
valid: boolean;
```

Whether all required resources are available
