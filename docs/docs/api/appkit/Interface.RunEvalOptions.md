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

### strict?

```ts
optional strict: boolean;
```

When true, soft assertion failures also fail the eval.
