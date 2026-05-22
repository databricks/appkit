# Variable: supervisorTools

```ts
const supervisorTools: {
  app: (__namedParameters: {
     description: string;
     name: string;
  }) => HostedSupervisorTool;
  genieSpace: (__namedParameters: {
     description: string;
     id: string;
  }) => HostedSupervisorTool;
  knowledgeAssistant: (__namedParameters: {
     description: string;
     knowledgeAssistantId: string;
  }) => HostedSupervisorTool;
  ucConnection: (__namedParameters: {
     description: string;
     name: string;
  }) => HostedSupervisorTool;
  ucFunction: (__namedParameters: {
     description: string;
     name: string;
  }) => HostedSupervisorTool;
};
```

Concise factories for declaring Supervisor API tools.

Each factory accepts a single named-options object: routing-critical
strings (`id`, `name`, `description`) get labels at the call site so
"we swapped the args and didn't notice for two weeks" bugs are
impossible.

`description` is required: SA's protobuf validation rejects `null`/`""`,
AND the LLM running on SA reads this string to decide when to route to
the tool. Two genie spaces both labelled "Genie space" give the model
nothing to discriminate on, so callers always own the routing hint.

⚠ The `description` is read by the LLM at routing time — it is a
prompt-injection sink. Do **not** derive it from untrusted input (user
messages, request bodies, external systems). Treat it as application
configuration. (CWE-1427)

## Type Declaration

### app()

```ts
app: (__namedParameters: {
  description: string;
  name: string;
}) => HostedSupervisorTool;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `__namedParameters` | \{ `description`: `string`; `name`: `string`; \} |
| `__namedParameters.description` | `string` |
| `__namedParameters.name` | `string` |

#### Returns

[`HostedSupervisorTool`](Interface.HostedSupervisorTool.md)

### genieSpace()

```ts
genieSpace: (__namedParameters: {
  description: string;
  id: string;
}) => HostedSupervisorTool;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `__namedParameters` | \{ `description`: `string`; `id`: `string`; \} |
| `__namedParameters.description` | `string` |
| `__namedParameters.id` | `string` |

#### Returns

[`HostedSupervisorTool`](Interface.HostedSupervisorTool.md)

### knowledgeAssistant()

```ts
knowledgeAssistant: (__namedParameters: {
  description: string;
  knowledgeAssistantId: string;
}) => HostedSupervisorTool;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `__namedParameters` | \{ `description`: `string`; `knowledgeAssistantId`: `string`; \} |
| `__namedParameters.description` | `string` |
| `__namedParameters.knowledgeAssistantId` | `string` |

#### Returns

[`HostedSupervisorTool`](Interface.HostedSupervisorTool.md)

### ucConnection()

```ts
ucConnection: (__namedParameters: {
  description: string;
  name: string;
}) => HostedSupervisorTool;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `__namedParameters` | \{ `description`: `string`; `name`: `string`; \} |
| `__namedParameters.description` | `string` |
| `__namedParameters.name` | `string` |

#### Returns

[`HostedSupervisorTool`](Interface.HostedSupervisorTool.md)

### ucFunction()

```ts
ucFunction: (__namedParameters: {
  description: string;
  name: string;
}) => HostedSupervisorTool;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `__namedParameters` | \{ `description`: `string`; `name`: `string`; \} |
| `__namedParameters.description` | `string` |
| `__namedParameters.name` | `string` |

#### Returns

[`HostedSupervisorTool`](Interface.HostedSupervisorTool.md)

## Example

```ts
import { createAgent } from "@databricks/appkit";
import {
  agents,
  DatabricksAdapter,
  supervisorTools,
} from "@databricks/appkit/beta";

const assistant = createAgent({
  instructions: "You are a helpful assistant.",
  model: DatabricksAdapter.fromSupervisorApi({
    model: "databricks-claude-sonnet-4",
  }),
  tools: () => ({
    nyc: supervisorTools.genieSpace({
      id: "01ABCDEF12345678",
      description: "NYC taxi trip records and zones",
    }),
    add: supervisorTools.ucFunction({
      name: "main.default.add",
      description: "Adds two integers and returns the sum.",
    }),
  }),
});
```
