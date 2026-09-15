# Interface: DriveResult

What a driver returns for a single `t.send`.

## Properties

### reply

```ts
reply: string;
```

The final assistant message text.

***

### sessionId?

```ts
optional sessionId: string;
```

Thread/session id, when the driver exposes one.

***

### succeeded

```ts
succeeded: boolean;
```

Whether the turn completed without an agent/stream error.

***

### toolCallDetails

```ts
toolCallDetails: {
  args: Record<string, unknown>;
  name: string;
}[];
```

Tool calls with their parsed arguments, in call order.

#### args

```ts
args: Record<string, unknown>;
```

#### name

```ts
name: string;
```

***

### toolCalls

```ts
toolCalls: string[];
```

Names of tools the agent called during the turn.

***

### traceId?

```ts
optional traceId: string;
```

MLflow trace id for the turn, when tracing is enabled on the app.
