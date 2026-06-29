# Interface: DiscoveredEval

An eval file found under `config/agents/<agent>/evals/`.

## Properties

### agent

```ts
agent: string;
```

The agent id (the `config/agents/<agent>` directory name).

***

### file

```ts
file: string;
```

Absolute path to the `*.eval.ts` file.

***

### id

```ts
id: string;
```

Id relative to the agent's evals dir, without `.eval.ts` (e.g. `weather/basic`).
