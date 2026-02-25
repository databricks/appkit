# Function: getUsernameWithApiLookup()

```ts
function getUsernameWithApiLookup(config?: Partial<LakebasePoolConfig>): Promise<string | undefined>;
```

Resolves the PostgreSQL username for a Lakebase connection.

Extends getUsernameSync with an async fallback that fetches the
current user's identity from the Databricks workspace API. Use this when
you don't have an explicit username configured and want automatic resolution
(e.g. human users authenticating via PAT or browser OAuth in ~/.databrickscfg).

Resolution priority:
1. `config.user` — explicit config value
2. `PGUSER` env var
3. `DATABRICKS_CLIENT_ID` env var (service principals)
4. `currentUser.me()` — fetched from Databricks workspace API

Returns `undefined` if all attempts fail rather than throwing, so the
caller can decide whether to proceed or surface an error.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `config?` | `Partial`\<[`LakebasePoolConfig`](Interface.LakebasePoolConfig.md)\> |

## Returns

`Promise`\<`string` \| `undefined`\>
