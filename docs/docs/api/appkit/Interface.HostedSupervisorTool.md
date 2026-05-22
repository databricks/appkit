# Interface: HostedSupervisorTool

Tagged record returned by every [supervisorTools](Variable.supervisorTools.md) factory. The
`__kind` discriminator lets the agents plugin (and standalone
`runAgent`) classify these tools without a structural match against the
wire format — keeps the SA wire shape free to evolve and avoids
namespace collisions with MCP hosted tools (which use `type: "genie-space"`
hyphenated, vs SA's `type: "genie_space"` underscored).

## Properties

### \_\_kind

```ts
readonly __kind: "hosted-supervisor";
```

***

### spec

```ts
readonly spec: SupervisorTool;
```
