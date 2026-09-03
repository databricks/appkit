# Interface: BasePluginConfig

Base configuration interface for AppKit plugins

## Extended by

- [`AgentsPluginConfig`](Interface.AgentsPluginConfig.md)
- [`IAiSearchConfig`](Interface.IAiSearchConfig.md)
- [`IJobsConfig`](Interface.IJobsConfig.md)

## Indexable

```ts
[key: string]: unknown
```

## Properties

### host?

```ts
optional host: string;
```

***

### name?

```ts
optional name: string;
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

***

### telemetry?

```ts
optional telemetry: TelemetryOptions;
```
