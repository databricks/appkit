# Interface: EvalConfig

Eval config from `evals.config.ts` (via [defineEvalConfig](Function.defineEvalConfig.md)).

Two scopes share this shape: a **root** `evals.config.ts` (project root) may
set run-wide settings — `baseUrl` and `webServer` — plus defaults for
`maxConcurrency`/`timeoutMs`; a **per-agent** `config/agents/<id>/evals/evals.config.ts`
sets only that agent's `maxConcurrency`/`timeoutMs` overrides (`baseUrl`/
`webServer` there are ignored — server lifecycle is run-wide).

## Properties

### baseUrl?

```ts
optional baseUrl: string;
```

Base URL of the app to drive (root config only). Overridden by `--url`.

***

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

***

### webServer?

```ts
optional webServer: EvalWebServer;
```

Auto-start the app under test (root config only).
