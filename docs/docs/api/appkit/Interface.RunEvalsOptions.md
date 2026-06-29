# Interface: RunEvalsOptions

## Properties

### baseUrl

```ts
baseUrl: string;
```

Base URL of the running app to drive, e.g. `http://localhost:3000`.

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

### mlflow?

```ts
optional mlflow: {
  experimentId: string;
  host: string;
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

Project root containing `config/agents/`. Defaults to `process.cwd()`.

***

### strict?

```ts
optional strict: boolean;
```

Soft assertion failures also fail the eval.
