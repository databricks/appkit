# Interface: ResolveDatabricksAuthOptions

## Properties

### host?

```ts
optional host: string;
```

Explicit host; wins over the profile/SDK-resolved host when set.

***

### profile?

```ts
optional profile: string;
```

`~/.databrickscfg` profile to authenticate with (e.g. `dogfood`).

***

### token?

```ts
optional token: string;
```

Explicit bearer token; when set, no OAuth is minted (PAT/CI path).
