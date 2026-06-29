# Interface: HttpDriverOptions

## Properties

### agent?

```ts
optional agent: string;
```

Agent alias to target. Omit to use the app's default agent.

***

### baseUrl

```ts
baseUrl: string;
```

Base URL of the running app, e.g. `http://localhost:3000`.

***

### headers?

```ts
optional headers: Record<string, string>;
```

Extra request headers (e.g. auth for a deployed app).

***

### mlflowRunId?

```ts
optional mlflowRunId: string;
```

MLflow run id to link each turn's trace to (for evaluation runs).

***

### path?

```ts
optional path: string;
```

Chat endpoint path. Defaults to `/api/agents/chat`.
