# Type Alias: AgentRemoteTraceEvent

```ts
type AgentRemoteTraceEvent =
  | {
  relation: "continued";
  source: "model-serving" | "supervisor" | "remote-agent";
  spanId?: string;
  traceId: string;
  type: "remote_trace";
}
  | {
  relation: "linked";
  source: "model-serving" | "supervisor" | "remote-agent";
  spanId: string;
  traceId: string;
  type: "remote_trace";
};
```
