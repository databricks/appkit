# Function: loadAgentsFromDir()

```ts
function loadAgentsFromDir(dir: string, ctx: LoadContext): Promise<LoadResult>;
```

Scans a directory for `*.md` files and produces an `AgentDefinition` record
keyed by file-stem. Throws on frontmatter errors or unresolved references.
Returns an empty map if the directory does not exist.

Runs in two passes so sub-agent references in frontmatter (`agents: [...]`)
can be resolved regardless of file-system iteration order:

1. Build every agent's definition from its own file.
2. Walk `agents:` references and wire `def.agents = { sibling: siblingDef }`
   by looking them up in the complete map. Dangling names and
   self-references fail loudly; mutual delegation is allowed and bounded
   at runtime by `limits.maxSubAgentDepth`.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `dir` | `string` |
| `ctx` | `LoadContext` |

## Returns

`Promise`\<`LoadResult`\>
