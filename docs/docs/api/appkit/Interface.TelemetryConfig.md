# Interface: TelemetryConfig

OpenTelemetry configuration for AppKit applications

## Properties

### exportIntervalMs?

```ts
optional exportIntervalMs: number;
```

***

### headers?

```ts
optional headers: Record<string, string>;
```

***

### instrumentations?

```ts
optional instrumentations: Instrumentation<InstrumentationConfig>[];
```

***

### mlflowUc?

```ts
optional mlflowUc: boolean | Partial<MlflowUcConfig>;
```

Export agent traces to an MLflow experiment backed by Unity Catalog.

***

### serviceName?

```ts
optional serviceName: string;
```

***

### serviceVersion?

```ts
optional serviceVersion: string;
```
