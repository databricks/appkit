# Interface: CallerContext

Caller identity and workspace for one immutable execution scope.

## Properties

### client

```ts
readonly client: WorkspaceClient;
```

***

### principal

```ts
readonly principal: CallerPrincipal;
```

***

### tokenFingerprint?

```ts
readonly optional tokenFingerprint: string;
```

Truncated SHA-256 hash of the caller token, used to detect rotation.

***

### workspaceId

```ts
readonly workspaceId: Promise<string>;
```
