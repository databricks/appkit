# @databricks/appkit

Core library for building Databricks applications with type-safe SQL queries,
plugin architecture, and React integration.

## Classes

| Class | Description |
| ------ | ------ |
| [Plugin](Class.Plugin.md) | Base abstract class for creating AppKit plugins |

## Interfaces

| Interface | Description |
| ------ | ------ |
| [BasePluginConfig](Interface.BasePluginConfig.md) | Base configuration interface for AppKit plugins |
| [CacheConfig](Interface.CacheConfig.md) | Configuration for caching |
| [ITelemetry](Interface.ITelemetry.md) | Plugin-facing interface for OpenTelemetry instrumentation. Provides a thin abstraction over OpenTelemetry APIs for plugins. |
| [StreamExecutionSettings](Interface.StreamExecutionSettings.md) | Configuration for streaming execution with default and user-scoped settings |
| [TelemetryConfig](Interface.TelemetryConfig.md) | OpenTelemetry configuration for AppKit applications |

## Type Aliases

| Type Alias | Description |
| ------ | ------ |
| [IAppRouter](TypeAlias.IAppRouter.md) | Express router type for plugin route registration |

## Variables

| Variable | Description |
| ------ | ------ |
| [sql](Variable.sql.md) | SQL helper namespace |

## Functions

| Function | Description |
| ------ | ------ |
| [appKitTypesPlugin](Function.appKitTypesPlugin.md) | Vite plugin to generate types for AppKit queries. Calls generateFromEntryPoint under the hood. |
| [createApp](Function.createApp.md) | Bootstraps AppKit with the provided configuration. |
| [isSQLTypeMarker](Function.isSQLTypeMarker.md) | Type guard to check if a value is a SQL type marker |
