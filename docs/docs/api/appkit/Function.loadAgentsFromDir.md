# Function: loadAgentsFromDir()

```ts
function loadAgentsFromDir(dir: string, ctx: LoadContext): Promise<LoadResult>;
```

Scans a directory for one subdirectory per agent, each containing
`agent.md` (frontmatter + body). Produces an `AgentDefinition` record keyed
by agent id (folder name). Throws on frontmatter errors or unresolved
references. Returns an empty map if the directory does not exist.

Legacy top-level `*.md` files are rejected with an error — migrate each to
`<id>/agent.md` under a sibling folder named for the agent id.

Runs in two passes so sub-agent references in frontmatter (`agents: [...]`)
can be resolved regardless of directory iteration order:

1. Build every agent's definition from its own `agent.md`.
2. Walk `agents:` references and wire `def.agents = { child: childDef }`
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
