# Interface: IAiSearchConfig

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

### indexes?

```ts
optional indexes: Record<string, IndexConfig>;
```

***

### name?

```ts
optional name: string;
```

#### Inherited from

[`BasePluginConfig`](Interface.BasePluginConfig.md).[`name`](Interface.BasePluginConfig.md#name)

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
