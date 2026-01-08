# @databricks/appkit

## Classes

| Class | Description |
| ------ | ------ |
| [Plugin](Class.Plugin.md) | - |
| [ServiceContext](Class.ServiceContext.md) | ServiceContext is a singleton that manages the service principal's WorkspaceClient and shared resources like warehouse/workspace IDs. |

## Interfaces

| Interface | Description |
| ------ | ------ |
| [BasePluginConfig](Interface.BasePluginConfig.md) | - |
| [CacheConfig](Interface.CacheConfig.md) | Configuration for caching |
| [ITelemetry](Interface.ITelemetry.md) | Plugin-facing interface for OpenTelemetry instrumentation. Provides a thin abstraction over OpenTelemetry APIs for plugins. |
| [ServiceContextState](Interface.ServiceContextState.md) | Service context holds the service principal client and shared resources. This is initialized once at app startup and shared across all requests. |
| [StreamExecutionSettings](Interface.StreamExecutionSettings.md) | - |
| [TelemetryConfig](Interface.TelemetryConfig.md) | - |
| [UserContext](Interface.UserContext.md) | User execution context extends the service context with user-specific data. Created on-demand when asUser(req) is called. |

## Type Aliases

| Type Alias | Description |
| ------ | ------ |
| [ExecutionContext](TypeAlias.ExecutionContext.md) | Execution context can be either service or user context. |
| [IAppRouter](TypeAlias.IAppRouter.md) | - |
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
| [getCurrentUserId](Function.getCurrentUserId.md) | Get the current user ID for cache keying and telemetry. |
| [getExecutionContext](Function.getExecutionContext.md) | Get the current execution context. |
| [getWarehouseId](Function.getWarehouseId.md) | Get the warehouse ID promise. |
| [getWorkspaceClient](Function.getWorkspaceClient.md) | Get the WorkspaceClient for the current execution context. |
| [getWorkspaceId](Function.getWorkspaceId.md) | Get the workspace ID promise. |
| [isInUserContext](Function.isInUserContext.md) | Check if currently running in a user context. |
| [isSQLTypeMarker](Function.isSQLTypeMarker.md) | Type guard to check if a value is a SQL type marker |
| [isUserContext](Function.isUserContext.md) | Check if an execution context is a user context. |
