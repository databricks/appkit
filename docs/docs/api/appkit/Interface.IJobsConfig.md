# Interface: IJobsConfig

Configuration for the Jobs plugin.

## Extends

- [`BasePluginConfig`](Interface.BasePluginConfig.md)

## Indexable

```ts
[key: string]: unknown
```

## Properties

### host?

```ts
optional host: string;
```

#### Inherited from

[`BasePluginConfig`](Interface.BasePluginConfig.md).[`host`](Interface.BasePluginConfig.md#host)

***

### jobs?

```ts
optional jobs: Record<string, JobConfig>;
```

Named jobs to expose. Each key becomes a job accessor.

***

### name?

```ts
optional name: string;
```

#### Inherited from

[`BasePluginConfig`](Interface.BasePluginConfig.md).[`name`](Interface.BasePluginConfig.md#name)

***

### pollIntervalMs?

```ts
optional pollIntervalMs: number;
```

Poll interval for waitForRun in milliseconds. Defaults to 5000.

***

### telemetry?

```ts
optional telemetry: TelemetryOptions;
```

#### Inherited from

[`BasePluginConfig`](Interface.BasePluginConfig.md).[`telemetry`](Interface.BasePluginConfig.md#telemetry)

***

### timeout?

```ts
optional timeout: number;
```

Operation timeout in milliseconds. Defaults to 60000.
