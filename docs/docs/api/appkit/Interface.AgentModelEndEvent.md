# Interface: AgentModelEndEvent

## Properties

### endedAt

```ts
endedAt: number;
```

***

### error?

```ts
optional error: string;
```

***

### finishReason?

```ts
optional finishReason: string;
```

***

### firstTokenAt?

```ts
optional firstTokenAt: number;
```

***

### model

```ts
model: string;
```

***

### output

```ts
output: unknown;
```

***

### provider

```ts
provider: string;
```

***

### stepId

```ts
stepId: string;
```

***

### streamDurationMs

```ts
streamDurationMs: number;
```

***

### type

```ts
type: "model_end";
```

***

### usage

```ts
usage: AgentUsage;
```
