# Interface: JobConfig

Per-job configuration options.

## Properties

### params?

```ts
optional params: ZodType<Record<string, unknown>, unknown, $ZodTypeInternals<Record<string, unknown>, unknown>>;
```

Optional Zod schema for validating job parameters at runtime.

***

### taskType?

```ts
optional taskType: TaskType;
```

The type of task this job runs. Determines how params are mapped to the SDK request.

***

### waitTimeout?

```ts
optional waitTimeout: number;
```

Maximum time (ms) to poll in runAndWait before giving up. Defaults to 600 000 (10 min).
