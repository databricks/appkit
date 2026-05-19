# Interface: RunAgentResult

## Properties

### events

```ts
events: AgentEvent[];
```

Every event the adapter yielded, in order. Useful for inspection/tests.

***

### text

```ts
text: string;
```

Aggregated text output from all `message_delta` events.
