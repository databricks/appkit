# Interface: AgentRunContext

## Properties

### executeTool()

```ts
executeTool: (name: string, args: unknown) => Promise<unknown>;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `name` | `string` |
| `args` | `unknown` |

#### Returns

`Promise`\<`unknown`\>

***

### signal?

```ts
optional signal: AbortSignal;
```
