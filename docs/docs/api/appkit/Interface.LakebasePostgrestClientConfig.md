# Interface: LakebasePostgrestClientConfig

Configuration for creating a Lakebase PostgREST client.

## Properties

### dataApiUrl?

```ts
optional dataApiUrl: string;
```

***

### fetch()?

```ts
optional fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `input` | `string` \| `URL` \| `Request` |
| `init?` | `RequestInit` |

#### Returns

`Promise`\<`Response`\>

***

### resolveToken

```ts
resolveToken: LakebaseTokenResolver;
```

***

### schema?

```ts
optional schema: string;
```
