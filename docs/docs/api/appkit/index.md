# @databricks/appkit

## Classes

| Class | Description |
| ------ | ------ |
| [Plugin](Class.Plugin.md) | - |

## Interfaces

| Interface | Description |
| ------ | ------ |
| [BasePluginConfig](Interface.BasePluginConfig.md) | - |
| [CacheConfig](Interface.CacheConfig.md) | Configuration for caching |
| [ITelemetry](Interface.ITelemetry.md) | Plugin-facing interface for OpenTelemetry instrumentation. Provides a thin abstraction over OpenTelemetry APIs for plugins. |
| [StreamExecutionSettings](Interface.StreamExecutionSettings.md) | - |
| [TelemetryConfig](Interface.TelemetryConfig.md) | - |

## Type Aliases

| Type Alias | Description |
| ------ | ------ |
| [IAppRouter](TypeAlias.IAppRouter.md) | - |
| [RequestContext](TypeAlias.RequestContext.md) | - |
| [SQLTypeMarker](TypeAlias.SQLTypeMarker.md) | Object that identifies a typed SQL parameter. Created using sql.date(), sql.string(), sql.number(), sql.boolean(), sql.timestamp(), sql.binary(), or sql.interval(). |

## Variables

| Variable | Description |
| ------ | ------ |
| [sql](Variable.sql.md) | SQL helper namespace |

## Functions

| Function | Description |
| ------ | ------ |
| [appKitTypesPlugin](Function.appKitTypesPlugin.md) | Vite plugin to generate types for AppKit queries. Calls generateFromEntryPoint under the hood. |
| [createApp](Function.createApp.md) | Bootstraps AppKit with the provided configuration. |
| [getRequestContext](Function.getRequestContext.md) | Retrieve the request-scoped context populated by `databricksClientMiddleware`. Throws when invoked outside of a request lifecycle. |
| [isSQLTypeMarker](Function.isSQLTypeMarker.md) | Type guard to check if a value is a SQL type marker |
