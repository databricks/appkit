# Interface: EvalConfig

Per-directory config from `evals.config.ts`.

## Properties

### judge?

```ts
optional judge: {
  model?: string;
};
```

LLM judge config. Defaults to the agent's own serving endpoint.

#### model?

```ts
optional model: string;
```

***

### maxConcurrency?

```ts
optional maxConcurrency: number;
```

Max evals to run concurrently.

***

### timeoutMs?

```ts
optional timeoutMs: number;
```

Default per-eval timeout.
