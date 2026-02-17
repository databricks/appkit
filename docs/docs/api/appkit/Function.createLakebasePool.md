# Function: createLakebasePool()

```ts
function createLakebasePool(config?: Partial<LakebasePoolConfig>): Pool;
```

Create a Lakebase pool with appkit's logger integration.
Telemetry automatically uses appkit's OpenTelemetry configuration via global registry.

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `config?` | `Partial`\<[`LakebasePoolConfig`](Interface.LakebasePoolConfig.md)\> | Lakebase pool configuration |

## Returns

`Pool`

PostgreSQL pool with appkit integration
