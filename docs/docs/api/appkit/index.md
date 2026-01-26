# @databricks/appkit

Core library for building Databricks applications with type-safe SQL queries,
plugin architecture, and React integration.

## Classes

| Class | Description |
| ------ | ------ |
| [AppKitError](Class.AppKitError.md) | Base error class for all AppKit errors. Provides a consistent structure for error handling across the framework. |
| [AuthenticationError](Class.AuthenticationError.md) | Error thrown when authentication fails. Use for missing tokens, invalid credentials, or authorization failures. |
| [ConfigurationError](Class.ConfigurationError.md) | Error thrown when configuration is missing or invalid. Use for missing environment variables, invalid settings, or setup issues. |
| [ConnectionError](Class.ConnectionError.md) | Error thrown when a connection or network operation fails. Use for database pool errors, API failures, timeouts, etc. |
| [ExecutionError](Class.ExecutionError.md) | Error thrown when an operation execution fails. Use for statement failures, canceled operations, or unexpected states. |
| [InitializationError](Class.InitializationError.md) | Error thrown when a service or component is not properly initialized. Use when accessing services before they are ready. |
| [Plugin](Class.Plugin.md) | Base abstract class for creating AppKit plugins |
| [ServerError](Class.ServerError.md) | Error thrown when server lifecycle operations fail. Use for server start/stop issues, configuration conflicts, etc. |
| [TunnelError](Class.TunnelError.md) | Error thrown when remote tunnel operations fail. Use for tunnel connection issues, message parsing failures, etc. |
| [ValidationError](Class.ValidationError.md) | Error thrown when input validation fails. Use for invalid parameters, missing required fields, or type mismatches. |

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
