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

### retries?

```ts
optional retries: number;
```

Re-run an eval up to this many extra times when it fails on an
infrastructure error (a thrown error or timeout — `result.error` set), to
absorb transient turn/stream flakiness. Assertion failures are NEVER
retried (a wrong reply is real signal, not flake). Defaults to `0`.

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

### tags?

```ts
optional tags: string[];
```

Only run evals whose `tags` intersect this list. Empty/undefined runs all.
Tags live on the eval def, so filtering happens after each file is loaded.

***

### timeoutMs?

```ts
optional timeoutMs: number;
```

Default per-eval timeout (ms): `runEval` races the whole test against it and
it also caps each driver turn. A per-eval `def.timeoutMs` overrides it, and
it wins over an agent's `evals.config.ts` `timeoutMs`. Unbounded when unset.

***

### warehouseId?

```ts
optional warehouseId: string;
```

SQL warehouse id used to read managed evaluation datasets.

***

### workspaceClient?

```ts
optional workspaceClient: WorkspaceClient;
```

Workspace client used to read managed evaluation datasets (for evals that
declare `dataset`). Required alongside [warehouseId](#warehouseid) for those evals.
