# Type Alias: AgentEvent

```ts
type AgentEvent = 
  | {
  content: string;
  type: "message_delta";
}
  | {
  content: string;
  type: "message";
}
  | {
  args: unknown;
  callId: string;
  name: string;
  type: "tool_call";
}
  | {
  callId: string;
  error?: string;
  result: unknown;
  type: "tool_result";
}
  | {
  content: string;
  type: "thinking";
}
  | {
  error?: string;
  status: "running" | "waiting" | "complete" | "error";
  type: "status";
}
  | {
  data: Record<string, unknown>;
  type: "metadata";
}
  | {
  annotations?: ToolAnnotations;
  approvalId: string;
  args: unknown;
  streamId: string;
  toolName: string;
  type: "approval_pending";
};
```

## Type Declaration

```ts
{
  content: string;
  type: "message_delta";
}
```

### content

```ts
content: string;
```

### type

```ts
type: "message_delta";
```

```ts
{
  content: string;
  type: "message";
}
```

### content

```ts
content: string;
```

### type

```ts
type: "message";
```

```ts
{
  args: unknown;
  callId: string;
  name: string;
  type: "tool_call";
}
```

### args

```ts
args: unknown;
```

### callId

```ts
callId: string;
```

### name

```ts
name: string;
```

### type

```ts
type: "tool_call";
```

```ts
{
  callId: string;
  error?: string;
  result: unknown;
  type: "tool_result";
}
```

### callId

```ts
callId: string;
```

### error?

```ts
optional error: string;
```

### result

```ts
result: unknown;
```

### type

```ts
type: "tool_result";
```

```ts
{
  content: string;
  type: "thinking";
}
```

### content

```ts
content: string;
```

### type

```ts
type: "thinking";
```

```ts
{
  error?: string;
  status: "running" | "waiting" | "complete" | "error";
  type: "status";
}
```

### error?

```ts
optional error: string;
```

### status

```ts
status: "running" | "waiting" | "complete" | "error";
```

### type

```ts
type: "status";
```

```ts
{
  data: Record<string, unknown>;
  type: "metadata";
}
```

### data

```ts
data: Record<string, unknown>;
```

### type

```ts
type: "metadata";
```

```ts
{
  annotations?: ToolAnnotations;
  approvalId: string;
  args: unknown;
  streamId: string;
  toolName: string;
  type: "approval_pending";
}
```

### annotations?

```ts
optional annotations: ToolAnnotations;
```

### approvalId

```ts
approvalId: string;
```

### args

```ts
args: unknown;
```

### streamId

```ts
streamId: string;
```

### toolName

```ts
toolName: string;
```

### type

```ts
type: "approval_pending";
```

Emitted by the agents plugin (not adapters) when a mutating tool call
is awaiting human approval — fires for tools annotated with
`effect: "write" | "update" | "destructive"` (preferred) or the
legacy `destructive: true` boolean. Clients should render an approval
prompt and POST to `/chat/approve` with the matching `approvalId` and
a `decision` of `approve` or `deny`.
