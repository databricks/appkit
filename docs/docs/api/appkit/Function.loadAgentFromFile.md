# Function: loadAgentFromFile()

```ts
function loadAgentFromFile(filePath: string, ctx: LoadContext): Promise<AgentDefinition>;
```

Loads a single markdown agent file and resolves its frontmatter against
registered plugin toolkits + ambient tool library.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `filePath` | `string` |
| `ctx` | `LoadContext` |

## Returns

`Promise`\<[`AgentDefinition`](Interface.AgentDefinition.md)\>
