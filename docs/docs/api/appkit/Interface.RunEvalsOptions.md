# Interface: RunEvalsOptions

## Properties

### baseUrl

```ts
baseUrl: string;
```

Base URL of the running app to drive, e.g. `http://localhost:3000`.

***

### concurrency?

```ts
optional concurrency: number;
```

Max evals to drive concurrently. Each eval opens one stream to the app as
the same user, so keep this at or below the app's
`maxConcurrentStreamsPerUser` (default 5) or the surplus streams hit the
429 guard. Defaults to 4; clamped to `[1, total]`.

***

### filter?

```ts
optional filter: string;
```

Substring filter on `<agent>/<id>` (or an exact agent id).

***

### headers?

```ts
optional headers: Record<string, string>;
```

Extra request headers for the driver (e.g. auth for a deployed app).

***

### judge?

```ts
optional judge: {
  host: string;
  model: string;
  token: string;
};
```

When set, enable `t.judge.*` LLM-as-judge scoring via autoevals against a
Databricks serving endpoint (`model`).

#### host

```ts
host: string;
```

#### model

```ts
model: string;
```

#### token

```ts
token: string;
```

***

### mlflow?

```ts
optional mlflow: {
  experimentId: string;
  host: string;
  sqlWarehouseId?: string;
  token: string;
};
```

When set, create a native MLflow "Evaluation run": each eval's trace is
linked to the run, pass/fail is written as feedback, and aggregate metrics
are logged. Requires Databricks creds + the target experiment.

#### experimentId

```ts
experimentId: string;
```

#### host

```ts
host: string;
```

#### sqlWarehouseId?

```ts
optional sqlWarehouseId: string;
```

SQL warehouse id for writing assessments to UC-backed (V4) traces.

#### token

```ts
token: string;
```

***

### now?

```ts
optional now: number;
```

Wall-clock timestamp (ms) for run create/finish — pass `Date.now()`.

***

### onEvent()?

```ts
optional onEvent: (event: EvalProgress) => void;
```

Progress callback, invoked as evals are discovered, started, and finished.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `event` | [`EvalProgress`](TypeAlias.EvalProgress.md) |

#### Returns

`void`

***

### rootDir?

```ts
optional rootDir: string;
```

Project root containing `server/agents/`. Defaults to `process.cwd()`.

***

### strict?

```ts
optional strict: boolean;
```

Soft assertion failures also fail the eval.

***

### timeoutMs?

```ts
optional timeoutMs: number;
```

Per-turn wall-clock timeout (ms) before a turn is failed. Defaults to 120s.
