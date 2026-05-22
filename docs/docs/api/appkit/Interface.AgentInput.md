# Interface: AgentInput

## Properties

### extensions?

```ts
optional extensions: Readonly<Record<string, unknown>>;
```

Adapter-specific opaque payloads, keyed by adapter namespace. The
shared contract intentionally does not enumerate keys — see each
adapter's docs for which keys it reads and the shape of each value.

The agents plugin and standalone `runAgent` populate this from the
agent's tool index when entries declare an adapter-side spec (e.g.
Supervisor API hosted tools). Adapters that don't read extensions
should leave it untouched.

***

### messages

```ts
messages: Message[];
```

***

### signal?

```ts
optional signal: AbortSignal;
```

***

### threadId

```ts
threadId: string;
```

***

### tools

```ts
tools: AgentToolDefinition[];
```
