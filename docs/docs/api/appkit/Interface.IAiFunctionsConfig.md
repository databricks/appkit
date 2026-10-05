# Interface: IAiFunctionsConfig

Base configuration interface for AppKit plugins

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

### name?

```ts
optional name: string;
```

#### Inherited from

[`BasePluginConfig`](Interface.BasePluginConfig.md).[`name`](Interface.BasePluginConfig.md#name)

***

### retry?

```ts
optional retry: RetryConfig;
```

Retry for unavailable (503) responses, and for any rate-limit (429)
response that reaches the plugin. In practice the Databricks SDK retries
429 internally until `timeout` cancels it, so a sustained rate limit
surfaces as a 504. Other errors are never retried.

#### Default

```ts
{ enabled: true, attempts: 3, initialDelay: 1000, maxDelay: 10000 }
```

***

### streamConfig?

```ts
optional streamConfig: StreamConfig;
```

SSE stream configuration for this plugin's `executeStream()` calls (buffer
sizes, `maxEventSize`, TTL, heartbeat). Sets the plugin's StreamManager
defaults; a per-call `stream` config still overrides these. Use it to raise
`maxEventSize` above the 5 MiB default when a stream emits larger events.

#### Inherited from

[`BasePluginConfig`](Interface.BasePluginConfig.md).[`streamConfig`](Interface.BasePluginConfig.md#streamconfig)

***

### tasks?

```ts
optional tasks: Readonly<Record<string, AiFunctionTask>>;
```

Named tasks exposed through HTTP routes, `useAiFunction`, and agent tools.

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

Timeout in milliseconds for one upstream attempt.

#### Default

```ts
60000
```
