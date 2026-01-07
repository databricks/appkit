# @databricks/appkit

## Classes

| Class | Description |
| ------ | ------ |
| [Plugin](classes/Plugin.md) | - |

## Interfaces

| Interface | Description |
| ------ | ------ |
| [BasePluginConfig](interfaces/BasePluginConfig.md) | - |
| [ITelemetry](interfaces/ITelemetry.md) | Plugin-facing interface for OpenTelemetry instrumentation. Provides a thin abstraction over OpenTelemetry APIs for plugins. |
| [StreamExecutionSettings](interfaces/StreamExecutionSettings.md) | - |

## Type Aliases

| Type Alias | Description |
| ------ | ------ |
| [IAppRouter](type-aliases/IAppRouter.md) | - |
| [SQLTypeMarker](type-aliases/SQLTypeMarker.md) | Object that identifies a typed SQL parameter. Created using sql.date(), sql.string(), sql.number(), sql.boolean(), sql.timestamp(), sql.binary(), or sql.interval(). |

## Functions

| Function | Description |
| ------ | ------ |
| [appKitTypesPlugin](functions/appKitTypesPlugin.md) | Vite plugin to generate types for AppKit queries. Calls generateFromEntryPoint under the hood. |
| [createApp](functions/createApp.md) | - |
| [getRequestContext](functions/getRequestContext.md) | - |
| [isSQLTypeMarker](functions/isSQLTypeMarker.md) | Type guard to check if a value is a SQL type marker |
| [toPlugin](functions/toPlugin.md) | - |

## Helpers

| Variable | Description |
| ------ | ------ |
| [sql](variables/sql.md) | SQL helper namespace |
