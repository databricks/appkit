# Variable: SUPERVISOR\_EXTENSION\_KEY

```ts
const SUPERVISOR_EXTENSION_KEY: "databricks.supervisor";
```

Namespace key under which the adapter reads its hosted-tool payload
from [AgentInput.extensions](Interface.AgentInput.md#extensions). Exported so the agents plugin and
standalone `runAgent` (the producers) can write under the same key the
adapter reads.
