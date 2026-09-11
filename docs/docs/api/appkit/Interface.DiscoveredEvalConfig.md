# Interface: DiscoveredEvalConfig

A per-agent `evals.config.ts` found under `server/agents/<agent>/evals/`.

## Properties

### agent

```ts
agent: string;
```

The agent id whose evals this config applies to.

***

### file

```ts
file: string;
```

Absolute path to the `evals.config.ts` file.
