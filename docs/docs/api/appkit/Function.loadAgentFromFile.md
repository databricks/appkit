# Function: loadAgentFromFile()

```ts
function loadAgentFromFile(filePath: string, ctx: LoadContext): Promise<AgentDefinition>;
```

Loads a single markdown agent file and resolves its frontmatter against
registered plugin toolkits + ambient tool library.

Rejects non-empty `agents:` frontmatter because single-file loads have
no siblings to resolve sub-agent references against — callers must use
[loadAgentsFromDir](Function.loadAgentsFromDir.md) when markdown agents delegate to one another.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `filePath` | `string` |
| `ctx` | `LoadContext` |

## Returns

`Promise`\<[`AgentDefinition`](Interface.AgentDefinition.md)\>
