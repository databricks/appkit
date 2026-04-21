# Function: loadAgentsFromDir()

```ts
function loadAgentsFromDir(dir: string, ctx: LoadContext): Promise<LoadResult>;
```

Scans a directory for `*.md` files and produces an `AgentDefinition` record
keyed by file-stem. Throws on frontmatter errors or unresolved references.
Returns an empty map if the directory does not exist.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `dir` | `string` |
| `ctx` | `LoadContext` |

## Returns

`Promise`\<`LoadResult`\>
