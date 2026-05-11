# @databricks/appkit

Documentation merge entry for Typedoc — combines the stable `@databricks/appkit`
surface with `@databricks/appkit/beta`. Not meant for application imports.

## Enumerations

| Enumeration | Description |
| ------ | ------ |
| [RequestedClaimsPermissionSet](Enumeration.RequestedClaimsPermissionSet.md) | Permission set for Unity Catalog table access |
| [ResourceType](Enumeration.ResourceType.md) | Resource types from schema $defs.resourceType.enum |

## Classes

| Class | Description |
| ------ | ------ |
| [AppKitError](Class.AppKitError.md) | Base error class for all AppKit errors. Provides a consistent structure for error handling across the framework. |
| [AppKitMcpClient](Class.AppKitMcpClient.md) | Lightweight MCP client for Databricks-hosted MCP servers. |
| [AuthenticationError](Class.AuthenticationError.md) | Error thrown when authentication fails. Use for missing tokens, invalid credentials, or authorization failures. |
| [ConfigurationError](Class.ConfigurationError.md) | Error thrown when configuration is missing or invalid. Use for missing environment variables, invalid settings, or setup issues. |
| [ConnectionError](Class.ConnectionError.md) | Error thrown when a connection or network operation fails. Use for database pool errors, API failures, timeouts, etc. |
| [DatabricksAdapter](Class.DatabricksAdapter.md) | Adapter that talks directly to Databricks Model Serving `/invocations` endpoint. |
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
| [AgentAdapter](Interface.AgentAdapter.md) | - |
| [AgentDefinition](Interface.AgentDefinition.md) | - |
| [AgentInput](Interface.AgentInput.md) | - |
| [AgentRunContext](Interface.AgentRunContext.md) | - |
| [AgentsPluginConfig](Interface.AgentsPluginConfig.md) | Base configuration interface for AppKit plugins |
| [AgentToolDefinition](Interface.AgentToolDefinition.md) | - |
| [AutoInheritToolsConfig](Interface.AutoInheritToolsConfig.md) | Auto-inherit configuration. When enabled for a given agent origin, agents with no explicit `tools:` declaration receive every registered ToolProvider plugin tool whose author marked `autoInheritable: true`. Tools without that flag — destructive, state-mutating, or privilege-sensitive — never spread automatically and must be wired via `tools:` (object or function form in code, `plugin:NAME` entries in markdown frontmatter). |
| [BasePluginConfig](Interface.BasePluginConfig.md) | Base configuration interface for AppKit plugins |
| [CacheConfig](Interface.CacheConfig.md) | Configuration for the CacheInterceptor. Controls TTL, size limits, storage backend, and probabilistic cleanup. |
| [DatabaseCredential](Interface.DatabaseCredential.md) | Database credentials with OAuth token for Postgres connection |
| [EndpointConfig](Interface.EndpointConfig.md) | - |
| [FilePolicyUser](Interface.FilePolicyUser.md) | Minimal user identity passed to the policy function. |
| [FileResource](Interface.FileResource.md) | Describes the file or directory being acted upon. |
| [FunctionTool](Interface.FunctionTool.md) | - |
| [GenerateDatabaseCredentialRequest](Interface.GenerateDatabaseCredentialRequest.md) | Request parameters for generating database OAuth credentials |
| [IJobsConfig](Interface.IJobsConfig.md) | Configuration for the Jobs plugin. |
| [ITelemetry](Interface.ITelemetry.md) | Plugin-facing interface for OpenTelemetry instrumentation. Provides a thin abstraction over OpenTelemetry APIs for plugins. |
| [JobAPI](Interface.JobAPI.md) | User-facing API for a single configured job. |
| [JobConfig](Interface.JobConfig.md) | Per-job configuration options. |
| [JobsConnectorConfig](Interface.JobsConnectorConfig.md) | - |
| [LakebasePoolConfig](Interface.LakebasePoolConfig.md) | Configuration for creating a Lakebase connection pool |
| [McpConnectAllResult](Interface.McpConnectAllResult.md) | Per-endpoint outcome of [AppKitMcpClient.connectAll](Class.AppKitMcpClient.md#connectall). Callers (the agents plugin in particular) use the split to warn at startup when some MCP servers are unreachable without aborting boot for the rest. |
| [Message](Interface.Message.md) | - |
| [PluginManifest](Interface.PluginManifest.md) | Plugin manifest that declares metadata and resource requirements. Attached to plugin classes as a static property. Extends the shared PluginManifest with strict resource types. |
| [PluginToolkitProvider](Interface.PluginToolkitProvider.md) | Minimum shape every entry in the [Plugins](TypeAlias.Plugins.md) map must expose. Core plugins (analytics, files, genie, lakebase) implement this directly via their `.toolkit()` method. The agents plugin and standalone `runAgent` synthesize this shape for any registered plugin that doesn't implement `.toolkit()` directly (falling back to `getAgentTools()` walking). |
| [PromptContext](Interface.PromptContext.md) | Context passed to `baseSystemPrompt` callbacks. |
| [RegisteredAgent](Interface.RegisteredAgent.md) | - |
| [RequestedClaims](Interface.RequestedClaims.md) | Optional claims for fine-grained Unity Catalog table permissions When specified, the returned token will be scoped to only the requested tables |
| [RequestedResource](Interface.RequestedResource.md) | Resource to request permissions for in Unity Catalog |
| [ResourceEntry](Interface.ResourceEntry.md) | Internal representation of a resource in the registry. Extends ResourceRequirement with resolution state and plugin ownership. |
| [ResourceFieldEntry](Interface.ResourceFieldEntry.md) | Defines a single field for a resource. Each field has its own environment variable and optional description. Single-value types use one key (e.g. id); multi-value types (database, secret) use multiple (e.g. instance_name, database_name or scope, key). |
| [ResourceRequirement](Interface.ResourceRequirement.md) | Declares a resource requirement for a plugin. Can be defined statically in a manifest or dynamically via getResourceRequirements(). Narrows the generated base: type → ResourceType enum, permission → ResourcePermission union. |
| [RunAgentInput](Interface.RunAgentInput.md) | - |
| [RunAgentResult](Interface.RunAgentResult.md) | - |
| [ServingEndpointEntry](Interface.ServingEndpointEntry.md) | Shape of a single registry entry. |
| [ServingEndpointRegistry](Interface.ServingEndpointRegistry.md) | Registry interface for serving endpoint type generation. Empty by default — augmented by the Vite type generator's `.d.ts` output via module augmentation. When populated, provides autocomplete for alias names and typed request/response/chunk per endpoint. |
| [StreamExecutionSettings](Interface.StreamExecutionSettings.md) | Execution settings for streaming endpoints. Extends PluginExecutionSettings with SSE stream configuration. |
| [TelemetryConfig](Interface.TelemetryConfig.md) | OpenTelemetry configuration for AppKit applications |
| [Thread](Interface.Thread.md) | - |
| [ThreadStore](Interface.ThreadStore.md) | - |
| [ToolAnnotations](Interface.ToolAnnotations.md) | - |
| [ToolConfig](Interface.ToolConfig.md) | - |
| [ToolEntry](Interface.ToolEntry.md) | Single-tool entry for a plugin's internal tool registry. |
| [ToolkitEntry](Interface.ToolkitEntry.md) | A tool reference produced by a plugin's `.toolkit()` call. The agents plugin recognizes the `__toolkitRef` brand and dispatches tool invocations through `PluginContext.executeTool(req, pluginName, localName, ...)`, preserving OBO (asUser) and telemetry spans. |
| [ToolkitOptions](Interface.ToolkitOptions.md) | - |
| [ToolProvider](Interface.ToolProvider.md) | - |
| [ValidationResult](Interface.ValidationResult.md) | Result of validating all registered resources against the environment. |

## Type Aliases

| Type Alias | Description |
| ------ | ------ |
| [AgentEvent](TypeAlias.AgentEvent.md) | - |
| [AgentTool](TypeAlias.AgentTool.md) | Any tool an agent can invoke: inline function tools (`tool()`), hosted MCP tools (`mcpServer()` / raw hosted), or toolkit references from plugins (`analytics().toolkit()`). |
| [AgentTools](TypeAlias.AgentTools.md) | Per-agent tool record. String keys map to inline tools, toolkit entries, hosted tools, etc. |
| [AgentToolsFn](TypeAlias.AgentToolsFn.md) | Function form of `AgentDefinition.tools`. Receives the typed [Plugins](TypeAlias.Plugins.md) map and returns a tool record. Invoked exactly once at setup (or once per `runAgent` call in standalone mode); the result is cached as the agent's resolved tool record. |
| [BaseSystemPromptOption](TypeAlias.BaseSystemPromptOption.md) | - |
| [ConfigSchema](TypeAlias.ConfigSchema.md) | Configuration schema definition for plugin config. Re-exported from the standard JSON Schema Draft 7 types. |
| [ExecutionResult](TypeAlias.ExecutionResult.md) | Discriminated union for plugin execution results. |
| [FileAction](TypeAlias.FileAction.md) | Every action the files plugin can perform. |
| [FilePolicy](TypeAlias.FilePolicy.md) | A policy function that decides whether `user` may perform `action` on `resource`. Return `true` to allow, `false` to deny. |
| [HostedTool](TypeAlias.HostedTool.md) | - |
| [IAppRouter](TypeAlias.IAppRouter.md) | Express router type for plugin route registration |
| [JobHandle](TypeAlias.JobHandle.md) | Job handle returned by `appkit.jobs("etl")`. Supports OBO access via `.asUser(req)`. |
| [JobsExport](TypeAlias.JobsExport.md) | Public API shape of the jobs plugin. Callable to select a job by key. |
| [PluginData](TypeAlias.PluginData.md) | Tuple of plugin class, config, and name. Created by `toPlugin()` and passed to `createApp()`. |
| [Plugins](TypeAlias.Plugins.md) | Plugin map passed to the function form of [AgentDefinition.tools](Interface.AgentDefinition.md#tools). Each entry exposes a `.toolkit(opts?)` method that returns a record of [ToolkitEntry](Interface.ToolkitEntry.md) markers ready to be spread into a tool record. |
| [ResolvedToolEntry](TypeAlias.ResolvedToolEntry.md) | Internal tool-index entry after a tool record has been resolved to a dispatchable form. |
| [ResourcePermission](TypeAlias.ResourcePermission.md) | Union of all possible permission levels across all resource types. |
| [ServingFactory](TypeAlias.ServingFactory.md) | Factory function returned by `AppKit.serving`. |
| [ToolRegistry](TypeAlias.ToolRegistry.md) | - |
| [ToPlugin](TypeAlias.ToPlugin.md) | Factory function type returned by `toPlugin()`. Accepts optional config and returns a PluginData tuple. |

## Variables

| Variable | Description |
| ------ | ------ |
| [agents](Variable.agents.md) | Plugin factory for the agents plugin. Reads `config/agents/*.md` by default, resolves toolkits/tools from registered plugins, exposes `appkit.agents.*` runtime API and mounts `/invocations`. |
| [READ\_ACTIONS](Variable.READ_ACTIONS.md) | Actions that only read data. |
| [sql](Variable.sql.md) | SQL helper namespace |
| [WRITE\_ACTIONS](Variable.WRITE_ACTIONS.md) | Actions that mutate data. |

## Functions

| Function | Description |
| ------ | ------ |
| [agentIdFromMarkdownPath](Function.agentIdFromMarkdownPath.md) | Derives the logical agent id from a markdown path. When the file is named `agent.md`, the id is the parent directory name (folder-based layout); otherwise the id is the file stem (e.g. legacy single-file paths). |
| [appKitServingTypesPlugin](Function.appKitServingTypesPlugin.md) | Vite plugin to generate TypeScript types for AppKit serving endpoints. Fetches OpenAPI schemas from Databricks and generates a .d.ts with ServingEndpointRegistry module augmentation. |
| [appKitTypesPlugin](Function.appKitTypesPlugin.md) | Vite plugin to generate types for AppKit queries. Calls generateFromEntryPoint under the hood. |
| [createAgent](Function.createAgent.md) | Pure factory for agent definitions. Returns the passed-in definition after cycle-detecting the sub-agent graph. Accepts the full `AgentDefinition` shape and is safe to call at module top-level. |
| [createApp](Function.createApp.md) | Bootstraps AppKit with the provided configuration. |
| [createLakebasePool](Function.createLakebasePool.md) | Create a Lakebase pool with appkit's logger integration. Telemetry automatically uses appkit's OpenTelemetry configuration via global registry. |
| [defineTool](Function.defineTool.md) | Defines a single tool entry for a plugin's internal registry. |
| [executeFromRegistry](Function.executeFromRegistry.md) | Validates tool-call arguments against the entry's schema and invokes its handler. On validation failure, returns an LLM-friendly error string (matching the behavior of `tool()`) rather than throwing, so the model can self-correct on its next turn. |
| [extractServingEndpoints](Function.extractServingEndpoints.md) | Extract serving endpoint config from a server file by AST-parsing it. Looks for `serving({ endpoints: { alias: { env: "..." }, ... } })` calls and extracts the endpoint alias names and their environment variable mappings. |
| [findServerFile](Function.findServerFile.md) | Find the server entry file by checking candidate paths in order. |
| [functionToolToDefinition](Function.functionToolToDefinition.md) | - |
| [generateDatabaseCredential](Function.generateDatabaseCredential.md) | Generate OAuth credentials for Postgres database connection using the proper Postgres API. |
| [getExecutionContext](Function.getExecutionContext.md) | Get the current execution context. |
| [getLakebaseOrmConfig](Function.getLakebaseOrmConfig.md) | Get Lakebase connection configuration for ORMs that don't accept pg.Pool directly. |
| [getLakebasePgConfig](Function.getLakebasePgConfig.md) | Get Lakebase connection configuration for PostgreSQL clients. |
| [getPluginManifest](Function.getPluginManifest.md) | Loads and validates the manifest from a plugin constructor. Normalizes string type/permission to strict ResourceType/ResourcePermission. |
| [getResourceRequirements](Function.getResourceRequirements.md) | Gets the resource requirements from a plugin's manifest. |
| [getUsernameWithApiLookup](Function.getUsernameWithApiLookup.md) | Resolves the PostgreSQL username for a Lakebase connection. |
| [getWorkspaceClient](Function.getWorkspaceClient.md) | Get workspace client from config or SDK default auth chain |
| [isFunctionTool](Function.isFunctionTool.md) | - |
| [isHostedTool](Function.isHostedTool.md) | - |
| [isSQLTypeMarker](Function.isSQLTypeMarker.md) | Type guard to check if a value is a SQL type marker |
| [isToolkitEntry](Function.isToolkitEntry.md) | Type guard for `ToolkitEntry` — used by the agents plugin to differentiate toolkit references from inline tools in a mixed `tools` record. |
| [loadAgentFromFile](Function.loadAgentFromFile.md) | Loads a single markdown agent file and resolves its frontmatter against registered plugin toolkits + ambient tool library. |
| [loadAgentsFromDir](Function.loadAgentsFromDir.md) | Scans a directory for one subdirectory per agent, each containing `agent.md` (frontmatter + body). Produces an `AgentDefinition` record keyed by agent id (folder name). Throws on frontmatter errors or unresolved references. Returns an empty map if the directory does not exist. |
| [mcpServer](Function.mcpServer.md) | Factory for declaring a custom MCP server tool. |
| [parseTextToolCalls](Function.parseTextToolCalls.md) | Parses text-based tool calls from model output. |
| [resolveHostedTools](Function.resolveHostedTools.md) | - |
| [runAgent](Function.runAgent.md) | Standalone agent execution without `createApp`. Resolves the adapter, binds inline tools, and drives the adapter's `run()` loop to completion. |
| [tool](Function.tool.md) | Factory for defining function tools with Zod schemas. |
| [toolsFromRegistry](Function.toolsFromRegistry.md) | Produces the `AgentToolDefinition[]` a ToolProvider exposes to the LLM, deriving `parameters` JSON Schema from each entry's Zod schema. |
