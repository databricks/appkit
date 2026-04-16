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
};
```
