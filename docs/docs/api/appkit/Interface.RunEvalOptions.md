# Interface: RunEvalOptions

## Properties

### driver

```ts
driver: EvalDriver;
```

Drives the agent and returns reply/tool-calls/success per `send`.

***

### id

```ts
id: string;
```

Stable id for the eval (e.g. its file path relative to the evals dir).

***

### row?

```ts
optional row: DatasetRow;
```

Dataset row bound to `t.input`/`t.expected` for dataset-driven evals.

***

### strict?

```ts
optional strict: boolean;
```

When true, soft assertion failures also fail the eval.

***

### timeoutMs?

```ts
optional timeoutMs: number;
```

Runner-level default per-eval timeout (ms). `def.timeoutMs` wins over this;
when both are unset the eval runs unbounded (current behavior).
