# Interface: SupervisorExtension

Shape of the value at `AgentInput.extensions[SUPERVISOR_EXTENSION_KEY]`.
The agents plugin / `runAgent` build this from the tool index; advanced
callers invoking `adapter.run(...)` directly populate it themselves.

## Properties

### hostedTools?

```ts
optional hostedTools: SupervisorTool[];
```
