# @databricks/appkit

Core library for building Databricks applications with type-safe SQL queries,
plugin architecture, and React integration.

## Enumerations

| Enumeration | Description |
| ------ | ------ |
| [RequestedClaimsPermissionSet](Enumeration.RequestedClaimsPermissionSet.md) | Permission set for Unity Catalog table access |
| [ResourceType](Enumeration.ResourceType.md) | Resource types from schema $defs.resourceType.enum |

## Classes

| Class | Description |
| ------ | ------ |
| [AppKitError](Class.AppKitError.md) | Base error class for all AppKit errors. Provides a consistent structure for error handling across the framework. |
| [AuthenticationError](Class.AuthenticationError.md) | Error thrown when authentication fails. Use for missing tokens, invalid credentials, or authorization failures. |
| [ConfigurationError](Class.ConfigurationError.md) | Error thrown when configuration is missing or invalid. Use for missing environment variables, invalid settings, or setup issues. |
| [ConnectionError](Class.ConnectionError.md) | Error thrown when a connection or network operation fails. Use for database pool errors, API failures, timeouts, etc. |
| [ExecutionError](Class.ExecutionError.md) | Error thrown when an operation execution fails. Use for statement failures, canceled operations, or unexpected states. |
| [InitializationError](Class.InitializationError.md) | Error thrown when a service or component is not properly initialized. Use when accessing services before they are ready. |
| [Plugin](Class.Plugin.md) | Base abstract class for creating AppKit plugins. |
| [PolicyDeniedError](Class.PolicyDeniedError.md) | Thrown when a policy denies an action. |
| [ResourceRegistry](Class.ResourceRegistry.md) | Central registry for tracking plugin resource requirements. Deduplication uses type + resourceKey (machine-stable); alias is for display only. |
| [ServerError](Class.ServerError.md) | Error thrown when server lifecycle operations fail. Use for server start/stop issues, configuration conflicts, etc. |
| [TunnelError](Class.TunnelError.md) | Error thrown when remote tunnel operations fail. Use for tunnel connection issues, message parsing failures, etc. |
| [ValidationError](Class.ValidationError.md) | Error thrown when input validation fails. Use for invalid parameters, missing required fields, or type mismatches. |

## Interfaces

| Interface | Description |
| ------ | ------ |
| [BasePluginConfig](Interface.BasePluginConfig.md) | Base configuration interface for AppKit plugins |
| [CacheConfig](Interface.CacheConfig.md) | Configuration for the CacheInterceptor. Controls TTL, size limits, storage backend, and probabilistic cleanup. |
| [DatabaseCredential](Interface.DatabaseCredential.md) | Database credentials with OAuth token for Postgres connection |
| [EndpointConfig](Interface.EndpointConfig.md) | - |
| [FilePolicyUser](Interface.FilePolicyUser.md) | Minimal user identity passed to the policy function. |
| [FileResource](Interface.FileResource.md) | Describes the file or directory being acted upon. |
| [GenerateDatabaseCredentialRequest](Interface.GenerateDatabaseCredentialRequest.md) | Request parameters for generating database OAuth credentials |
| [IJobsConfig](Interface.IJobsConfig.md) | Configuration for the Jobs plugin. |
| [ITelemetry](Interface.ITelemetry.md) | Plugin-facing interface for OpenTelemetry instrumentation. Provides a thin abstraction over OpenTelemetry APIs for plugins. |
| [JobAPI](Interface.JobAPI.md) | User-facing API for a single configured job. |
| [JobConfig](Interface.JobConfig.md) | Per-job configuration options. |
| [JobsConnectorConfig](Interface.JobsConnectorConfig.md) | - |
| [LakebasePoolConfig](Interface.LakebasePoolConfig.md) | Configuration for creating a Lakebase connection pool |
| [PluginManifest](Interface.PluginManifest.md) | Plugin manifest that declares metadata and resource requirements. Attached to plugin classes as a static property. Extends the shared PluginManifest with strict resource types. |
| [RequestedClaims](Interface.RequestedClaims.md) | Optional claims for fine-grained Unity Catalog table permissions When specified, the returned token will be scoped to only the requested tables |
| [RequestedResource](Interface.RequestedResource.md) | Resource to request permissions for in Unity Catalog |
| [ResourceEntry](Interface.ResourceEntry.md) | Internal representation of a resource in the registry. Extends ResourceRequirement with resolution state and plugin ownership. |
| [ResourceFieldEntry](Interface.ResourceFieldEntry.md) | Defines a single field for a resource. Each field has its own environment variable and optional description. Single-value types use one key (e.g. id); multi-value types (database, secret) use multiple (e.g. instance_name, database_name or scope, key). |
| [ResourceRequirement](Interface.ResourceRequirement.md) | Declares a resource requirement for a plugin. Can be defined statically in a manifest or dynamically via getResourceRequirements(). Narrows the generated base: type → ResourceType enum, permission → ResourcePermission union. |
| [ServingEndpointEntry](Interface.ServingEndpointEntry.md) | Shape of a single registry entry. |
| [ServingEndpointRegistry](Interface.ServingEndpointRegistry.md) | Registry interface for serving endpoint type generation. Empty by default — augmented by the Vite type generator's `.d.ts` output via module augmentation. When populated, provides autocomplete for alias names and typed request/response/chunk per endpoint. |
| [StreamExecutionSettings](Interface.StreamExecutionSettings.md) | Execution settings for streaming endpoints. Extends PluginExecutionSettings with SSE stream configuration. |
| [TelemetryConfig](Interface.TelemetryConfig.md) | OpenTelemetry configuration for AppKit applications |
| [ValidationResult](Interface.ValidationResult.md) | Result of validating all registered resources against the environment. |

## Type Aliases

| Type Alias | Description |
| ------ | ------ |
| [ConfigSchema](TypeAlias.ConfigSchema.md) | Configuration schema definition for plugin config. Re-exported from the standard JSON Schema Draft 7 types. |
| [ExecutionResult](TypeAlias.ExecutionResult.md) | Discriminated union for plugin execution results. |
| [FileAction](TypeAlias.FileAction.md) | Every action the files plugin can perform. |
| [FilePolicy](TypeAlias.FilePolicy.md) | A policy function that decides whether `user` may perform `action` on `resource`. Return `true` to allow, `false` to deny. |
| [IAppRouter](TypeAlias.IAppRouter.md) | Express router type for plugin route registration |
| [JobHandle](TypeAlias.JobHandle.md) | Job handle returned by `appkit.jobs("etl")`. Supports OBO access via `.asUser(req)`. |
| [JobsExport](TypeAlias.JobsExport.md) | Public API shape of the jobs plugin. Callable to select a job by key. |
| [PluginData](TypeAlias.PluginData.md) | Tuple of plugin class, config, and name. Created by `toPlugin()` and passed to `createApp()`. |
| [ResourcePermission](TypeAlias.ResourcePermission.md) | Union of all possible permission levels across all resource types. |
| [ServingFactory](TypeAlias.ServingFactory.md) | Factory function returned by `AppKit.serving`. |
| [ToPlugin](TypeAlias.ToPlugin.md) | Factory function type returned by `toPlugin()`. Accepts optional config and returns a PluginData tuple. |

## Variables

| Variable | Description |
| ------ | ------ |
| [READ\_ACTIONS](Variable.READ_ACTIONS.md) | Actions that only read data. |
| [sql](Variable.sql.md) | SQL helper namespace |
| [WRITE\_ACTIONS](Variable.WRITE_ACTIONS.md) | Actions that mutate data. |

## Functions

| Function | Description |
| ------ | ------ |
| [appKitServingTypesPlugin](Function.appKitServingTypesPlugin.md) | Vite plugin to generate TypeScript types for AppKit serving endpoints. Fetches OpenAPI schemas from Databricks and generates a .d.ts with ServingEndpointRegistry module augmentation. |
| [appKitTypesPlugin](Function.appKitTypesPlugin.md) | Vite plugin to generate types for AppKit queries. Calls generateFromEntryPoint under the hood. |
| [createApp](Function.createApp.md) | Bootstraps AppKit with the provided configuration. |
| [createLakebasePool](Function.createLakebasePool.md) | Create a Lakebase pool with appkit's logger integration. Telemetry automatically uses appkit's OpenTelemetry configuration via global registry. |
| [extractServingEndpoints](Function.extractServingEndpoints.md) | Extract serving endpoint config from a server file by AST-parsing it. Looks for `serving({ endpoints: { alias: { env: "..." }, ... } })` calls and extracts the endpoint alias names and their environment variable mappings. |
| [findServerFile](Function.findServerFile.md) | Find the server entry file by checking candidate paths in order. |
| [generateDatabaseCredential](Function.generateDatabaseCredential.md) | Generate OAuth credentials for Postgres database connection using the proper Postgres API. |
| [getExecutionContext](Function.getExecutionContext.md) | Get the current execution context. |
| [getLakebaseOrmConfig](Function.getLakebaseOrmConfig.md) | Get Lakebase connection configuration for ORMs that don't accept pg.Pool directly. |
| [getLakebasePgConfig](Function.getLakebasePgConfig.md) | Get Lakebase connection configuration for PostgreSQL clients. |
| [getPluginManifest](Function.getPluginManifest.md) | Loads and validates the manifest from a plugin constructor. Normalizes string type/permission to strict ResourceType/ResourcePermission. |
| [getResourceRequirements](Function.getResourceRequirements.md) | Gets the resource requirements from a plugin's manifest. |
| [getUsernameWithApiLookup](Function.getUsernameWithApiLookup.md) | Resolves the PostgreSQL username for a Lakebase connection. |
| [getWorkspaceClient](Function.getWorkspaceClient.md) | Get workspace client from config or SDK default auth chain |
| [isSQLTypeMarker](Function.isSQLTypeMarker.md) | Type guard to check if a value is a SQL type marker |
