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

***

### timeoutMs?

```ts
optional timeoutMs: number;
```

Max wall-clock time for a single turn before it is abandoned as a failed
turn (`succeeded: false`). Without this a hung agent — a blocked tool, a
stalled model — never ends the SSE stream (heartbeats keep it alive), so
the read loop spins forever and wedges the whole sequential suite.
Defaults to 120s.
