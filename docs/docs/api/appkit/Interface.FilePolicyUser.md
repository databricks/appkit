# Interface: FilePolicyUser

Minimal user identity passed to the policy function.

## Properties

### id

```ts
id: string;
```

***

### isServicePrincipal?

```ts
optional isServicePrincipal: boolean;
```

`true` when the caller is the service principal (direct SDK call, not `asUser`).
