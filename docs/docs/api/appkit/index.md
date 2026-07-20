# @databricks/appkit

Documentation merge entry for Typedoc — combines the stable `@databricks/appkit`
surface with `@databricks/appkit/beta`. Not meant for application imports.

## Enumerations

| Enumeration | Description |
| ------ | ------ |
| [RequestedClaimsPermissionSet](Enumeration.RequestedClaimsPermissionSet.md) | Permission set for Unity Catalog table access |
| [ResourceType](Enumeration.ResourceType.md) | Resource types from resourceTypeSchema.options |

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
| [MlflowClient](Class.MlflowClient.md) | A thin client over the Databricks workspace REST API, owning the host + bearer token so callers (eval-run creation, assessment writes, the judge's serving endpoint) don't each re-derive URLs or re-attach auth. The host is normalized once at construction. |
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
| [AssertionHandle](Interface.AssertionHandle.md) | Chainable handle returned by every assertion to control its severity. Mirrors eve: assertions are gates by default; `.soft()` demotes to a tracked metric; `.atLeast(n)` is a soft, score-thresholded assertion. |
| [AssertionResult](Interface.AssertionResult.md) | A single recorded assertion outcome. |
| [Assessment](Interface.Assessment.md) | A Feedback assessment in the MLflow REST proto-JSON shape. |
| [AutoInheritToolsConfig](Interface.AutoInheritToolsConfig.md) | Auto-inherit configuration. When enabled for a given agent origin, agents with no explicit `tools:` declaration receive every registered ToolProvider plugin tool whose author marked `autoInheritable: true`. Tools without that flag — destructive, state-mutating, or privilege-sensitive — never spread automatically and must be wired via `tools:` (object or function form in code, `plugin:NAME` entries in markdown frontmatter). |
| [BasePluginConfig](Interface.BasePluginConfig.md) | Base configuration interface for AppKit plugins |
| [CacheConfig](Interface.CacheConfig.md) | Configuration for the CacheInterceptor. Controls TTL, size limits, storage backend, and probabilistic cleanup. |
| [CustomJudgeSpec](Interface.CustomJudgeSpec.md) | A custom LLM-judge definition: a prompt template and choice→score mapping. |
| [DatabaseCredential](Interface.DatabaseCredential.md) | Database credentials with OAuth token for Postgres connection |
| [DatabricksAuth](Interface.DatabricksAuth.md) | Resolved Databricks host + bearer token for the eval runner's REST calls. |
| [DatasetRow](Interface.DatasetRow.md) | One row of a managed evaluation dataset. `inputs` are the kwargs passed to the agent for the turn; `expectations` (when present) is the row's ground truth / guidelines. Mirrors the `{inputs, expectations}` shape of `mlflow.genai` datasets and of the Unity Catalog table backing a managed eval dataset. |
| [DiscoveredEval](Interface.DiscoveredEval.md) | An eval file found under `config/agents/<agent>/evals/`. |
| [DiscoveredEvalConfig](Interface.DiscoveredEvalConfig.md) | A per-agent `evals.config.ts` found under `config/agents/<agent>/evals/`. |
| [DriveResult](Interface.DriveResult.md) | What a driver returns for a single `t.send`. |
| [EndpointConfig](Interface.EndpointConfig.md) | - |
| [EvalConfig](Interface.EvalConfig.md) | Eval config from `evals.config.ts` (via [defineEvalConfig](Function.defineEvalConfig.md)). |
| [EvalDefinition](Interface.EvalDefinition.md) | A single eval, default-exported from a `*.eval.ts` file. |
| [EvalDriver](Interface.EvalDriver.md) | Abstraction over how the agent is driven. The HTTP driver posts to a running app's agents endpoint; future drivers (in-process) implement the same shape. |
| [EvalResult](Interface.EvalResult.md) | The outcome of running one eval. |
| [EvalRunSummary](Interface.EvalRunSummary.md) | - |
| [EvalSummary](Interface.EvalSummary.md) | - |
| [EvalWebServer](Interface.EvalWebServer.md) | Auto-start config for the app under test, à la Playwright's `webServer`. When set in a root `evals.config.ts`, the CLI boots the app before running evals and tears it down after — so you don't have to start the server by hand. |
| [FilePolicyUser](Interface.FilePolicyUser.md) | Minimal user identity passed to the policy function. |
| [FileResource](Interface.FileResource.md) | Describes the file or directory being acted upon. |
| [FunctionTool](Interface.FunctionTool.md) | - |
| [GenerateDatabaseCredentialRequest](Interface.GenerateDatabaseCredentialRequest.md) | Request parameters for generating database OAuth credentials |
| [HttpDriverOptions](Interface.HttpDriverOptions.md) | - |
| [IJobsConfig](Interface.IJobsConfig.md) | Configuration for the Jobs plugin. |
| [ITelemetry](Interface.ITelemetry.md) | Plugin-facing interface for OpenTelemetry instrumentation. Provides a thin abstraction over OpenTelemetry APIs for plugins. |
| [JobAPI](Interface.JobAPI.md) | User-facing API for a single configured job. |
| [JobConfig](Interface.JobConfig.md) | Per-job configuration options. |
| [JobsConnectorConfig](Interface.JobsConnectorConfig.md) | - |
| [JudgeConfig](Interface.JudgeConfig.md) | - |
| [JudgeScore](Interface.JudgeScore.md) | A normalized judge result. `score` is 0..1. |
| [LakebasePool](Interface.LakebasePool.md) | Subset of `pg.Pool` exposed by the Lakebase plugin. |
| [LakebasePoolConfig](Interface.LakebasePoolConfig.md) | Configuration for creating a Lakebase connection pool |
| [LakebasePoolManager](Interface.LakebasePoolManager.md) | Manages multiple Lakebase connection pools keyed by an identifier (e.g. userId). |
| [MatchResult](Interface.MatchResult.md) | Result of a deterministic matcher run against a value. |
| [McpConnectAllResult](Interface.McpConnectAllResult.md) | Per-endpoint outcome of [AppKitMcpClient.connectAll](Class.AppKitMcpClient.md#connectall). Callers (the agents plugin in particular) use the split to warn at startup when some MCP servers are unreachable without aborting boot for the rest. |
| [Message](Interface.Message.md) | - |
| [PluginManifest](Interface.PluginManifest.md) | Plugin manifest that declares metadata and resource requirements. Attached to plugin classes as a static property. Extends the shared PluginManifest with strict resource types. |
| [PluginToolkitProvider](Interface.PluginToolkitProvider.md) | Minimum shape every entry in the [Plugins](TypeAlias.Plugins.md) map must expose. Core plugins (analytics, files, genie, lakebase) implement this directly via their `.toolkit()` method. The agents plugin and standalone `runAgent` synthesize this shape for any registered plugin that doesn't implement `.toolkit()` directly (falling back to `getAgentTools()` walking). |
| [PostResult](Interface.PostResult.md) | Structured result for a best-effort POST that must not throw. |
| [PromptContext](Interface.PromptContext.md) | Context passed to `baseSystemPrompt` callbacks. |
| [ReadEvalDatasetOptions](Interface.ReadEvalDatasetOptions.md) | - |
| [RegisteredAgent](Interface.RegisteredAgent.md) | - |
| [ReportOutcome](Interface.ReportOutcome.md) | - |
| [RequestedClaims](Interface.RequestedClaims.md) | Optional claims for fine-grained Unity Catalog table permissions When specified, the returned token will be scoped to only the requested tables |
| [RequestedResource](Interface.RequestedResource.md) | Resource to request permissions for in Unity Catalog |
| [ResolveDatabricksAuthOptions](Interface.ResolveDatabricksAuthOptions.md) | - |
| [ResourceEntry](Interface.ResourceEntry.md) | Internal representation of a resource in the registry. Extends ResourceRequirement with resolution state and plugin ownership. |
| [ResourceRequirement](Interface.ResourceRequirement.md) | Declares a resource requirement for a plugin. Can be defined statically in a manifest or dynamically via getResourceRequirements(). |
| [RunAgentInput](Interface.RunAgentInput.md) | - |
| [RunAgentResult](Interface.RunAgentResult.md) | - |
| [RunEvalOptions](Interface.RunEvalOptions.md) | - |
| [RunEvalsOptions](Interface.RunEvalsOptions.md) | - |
| [ServingEndpointEntry](Interface.ServingEndpointEntry.md) | Shape of a single registry entry. |
| [ServingEndpointRegistry](Interface.ServingEndpointRegistry.md) | Registry interface for serving endpoint type generation. Empty by default — augmented by the Vite type generator's `.d.ts` output via module augmentation. When populated, provides autocomplete for alias names and typed request/response/chunk per endpoint. |
| [StreamExecutionSettings](Interface.StreamExecutionSettings.md) | Execution settings for streaming endpoints. Extends PluginExecutionSettings with SSE stream configuration. |
| [TelemetryConfig](Interface.TelemetryConfig.md) | OpenTelemetry configuration for AppKit applications |
| [TestContext](Interface.TestContext.md) | The `t` context passed to an eval's `test` function. |
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
| [EvalProgress](TypeAlias.EvalProgress.md) | - |
| [ExecutionResult](TypeAlias.ExecutionResult.md) | Discriminated union for plugin execution results. |
| [FileAction](TypeAlias.FileAction.md) | Every action the files plugin can perform. |
| [FilePolicy](TypeAlias.FilePolicy.md) | A policy function that decides whether `user` may perform `action` on `resource`. Return `true` to allow, `false` to deny. |
| [HostedTool](TypeAlias.HostedTool.md) | - |
| [IAppRouter](TypeAlias.IAppRouter.md) | Express router type for plugin route registration |
| [JobHandle](TypeAlias.JobHandle.md) | Job handle returned by `appkit.jobs("etl")`. Supports OBO access via `.asUser(req)`. |
| [JobsExport](TypeAlias.JobsExport.md) | Public API shape of the jobs plugin. Callable to select a job by key. |
| [Matcher](TypeAlias.Matcher.md) | A deterministic matcher: inspects a string value and returns a result. |
| [PluginData](TypeAlias.PluginData.md) | Tuple of plugin class, config, and name. Created by `toPlugin()` and passed to `createApp()`. |
| [Plugins](TypeAlias.Plugins.md) | Plugin map passed to the function form of [AgentDefinition.tools](Interface.AgentDefinition.md#tools). Each entry exposes a `.toolkit(opts?)` method that returns a record of [ToolkitEntry](Interface.ToolkitEntry.md) markers ready to be spread into a tool record. |
| [ResolvedToolEntry](TypeAlias.ResolvedToolEntry.md) | Internal tool-index entry after a tool record has been resolved to a dispatchable form. |
| [ResourceFieldEntry](TypeAlias.ResourceFieldEntry.md) | - |
| [ResourcePermission](TypeAlias.ResourcePermission.md) | Union of all possible permission levels across all resource types. |
| [ServingFactory](TypeAlias.ServingFactory.md) | Factory function returned by `AppKit.serving`. |
| [Severity](TypeAlias.Severity.md) | Whether an assertion fails the eval (`gate`) or is tracked only (`soft`). |
| [ToolRegistry](TypeAlias.ToolRegistry.md) | - |
| [ToPlugin](TypeAlias.ToPlugin.md) | Factory function type returned by `toPlugin()`. Accepts optional config and returns a PluginData tuple. |

## Variables

| Variable | Description |
| ------ | ------ |
| [agents](Variable.agents.md) | Plugin factory for the agents plugin. Reads `config/agents/*.md` by default, resolves toolkits/tools from registered plugins, exposes `appkit.agents.*` runtime API and mounts `POST /invocations` and `POST /responses` (aliased non-streaming invoke endpoints) plus `POST /chat` (streaming, HITL-capable). |
| [READ\_ACTIONS](Variable.READ_ACTIONS.md) | Actions that only read data. |
| [sql](Variable.sql.md) | SQL helper namespace |
| [WRITE\_ACTIONS](Variable.WRITE_ACTIONS.md) | Actions that mutate data. |

## Functions

| Function | Description |
| ------ | ------ |
| [agentIdFromMarkdownPath](Function.agentIdFromMarkdownPath.md) | Derives the logical agent id from a markdown path. When the file is named `agent.md`, the id is the parent directory name (folder-based layout); otherwise the id is the file stem (e.g. legacy single-file paths). |
| [appKitServingTypesPlugin](Function.appKitServingTypesPlugin.md) | Vite plugin to generate TypeScript types for AppKit serving endpoints. Fetches OpenAPI schemas from Databricks and generates a .d.ts with ServingEndpointRegistry module augmentation. |
| [appKitTypesPlugin](Function.appKitTypesPlugin.md) | Vite plugin to generate types for AppKit queries. Calls generateFromEntryPoint under the hood. |
| [buildAssessments](Function.buildAssessments.md) | Build the Feedback assessments for an eval result: one per assertion (judge assertions tagged `LLM_JUDGE` with their numeric score + rationale, so they render as judge feedback in MLflow) plus an overall `appkit_eval` pass/fail. Returns [] when there's no trace to attach to or the eval was skipped. |
| [configureJudge](Function.configureJudge.md) | Configure the judge once. Sets the OpenAI-compatible client env autoevals reads and the default judge model. No-op-safe: on failure, judging stays disabled and [isJudgeConfigured](Function.isJudgeConfigured.md) returns false. |
| [createAgent](Function.createAgent.md) | Pure factory for agent definitions. Returns the passed-in definition after cycle-detecting the sub-agent graph. Accepts the full `AgentDefinition` shape and is safe to call at module top-level. |
| [createApp](Function.createApp.md) | Bootstraps AppKit with the provided configuration. |
| [createHttpDriver](Function.createHttpDriver.md) | Drives an agent by POSTing to a running app's chat endpoint and parsing the SSE response. Keeps the thread id across `send`s so multi-turn evals share a conversation. Agent/stream errors surface as `succeeded: false` rather than throwing, so `t.succeeded()` can assert on them. |
| [createLakebasePool](Function.createLakebasePool.md) | Create a Lakebase pool with appkit's logger integration. Telemetry automatically uses appkit's OpenTelemetry configuration via global registry. |
| [createLakebasePoolManager](Function.createLakebasePoolManager.md) | Create a pool manager that maintains per-key Lakebase connection pools. |
| [defineEval](Function.defineEval.md) | Define an agent eval. Default-export the result from a `config/agents/<id>/evals/*.eval.ts` file. |
| [defineEvalConfig](Function.defineEvalConfig.md) | Define per-directory eval config. Default-export from `evals.config.ts`. |
| [defineTool](Function.defineTool.md) | Defines a single tool entry for a plugin's internal registry. |
| [discoverEvalConfigs](Function.discoverEvalConfigs.md) | Discover the per-agent `evals.config.ts` (from [defineEvalConfig](Function.defineEvalConfig.md)) at `<rootDir>/config/agents/<agent>/evals/evals.config.ts`. Config is per-agent: each agent's config applies only to that agent's evals. Agents without a config file are omitted. Returns a stable, sorted list. |
| [discoverEvalFiles](Function.discoverEvalFiles.md) | Discover evals under `<rootDir>/config/agents/<agent>/evals/`. The agent id is the directory name; the eval id is the file path relative to that evals dir with `.eval.ts` stripped. Returns a stable, sorted list. |
| [equals](Function.equals.md) | Passes when the value equals `expected` exactly. |
| [evalGlyph](Function.evalGlyph.md) | Status glyph for a single eval result. |
| [executeFromRegistry](Function.executeFromRegistry.md) | Validates tool-call arguments against the entry's schema and invokes its handler. On validation failure, returns an LLM-friendly error string (matching the behavior of `tool()`) rather than throwing, so the model can self-correct on its next turn. |
| [extractServingEndpoints](Function.extractServingEndpoints.md) | Extract serving endpoint config from a server file by AST-parsing it. Looks for `serving({ endpoints: { alias: { env: "..." }, ... } })` calls and extracts the endpoint alias names and their environment variable mappings. |
| [findRootEvalConfig](Function.findRootEvalConfig.md) | Path to the root `evals.config.ts` (from [defineEvalConfig](Function.defineEvalConfig.md)) at `<rootDir>/evals.config.ts`, or `undefined` when absent. The root config holds run-wide settings (`baseUrl`, `webServer`); it's distinct from the per-agent configs found by [discoverEvalConfigs](Function.discoverEvalConfigs.md). |
| [findServerFile](Function.findServerFile.md) | Find the server entry file by checking candidate paths in order. |
| [formatEvalDetail](Function.formatEvalDetail.md) | Indented detail lines for a failing eval (error + failing assertions). |
| [formatEvalHeadline](Function.formatEvalHeadline.md) | The one-line header for a single eval result (no failure detail). |
| [formatEvalResults](Function.formatEvalResults.md) | Render all results as a human-readable console report (non-streaming). |
| [formatResultsJson](Function.formatResultsJson.md) | Render results as a machine-readable JSON report (2-space indented): `{ summary: EvalSummary, results: EvalResult[] }`. Faithful to the types — every field present on a result round-trips. |
| [formatResultsJUnit](Function.formatResultsJUnit.md) | Render results as JUnit XML for standard CI test reporters: a single `<testsuite name="appkit-agent-evals">` with one `<testcase>` per result. Failures carry a `<failure>` (error or failing-gate summary); skips a `<skipped>`. All attribute/text values are XML-escaped. |
| [formatSummaryLine](Function.formatSummaryLine.md) | The final PASS/FAIL summary line. |
| [functionToolToDefinition](Function.functionToolToDefinition.md) | - |
| [generateDatabaseCredential](Function.generateDatabaseCredential.md) | Generate OAuth credentials for Postgres database connection using the proper Postgres API. |
| [getExecutionContext](Function.getExecutionContext.md) | Get the current execution context. |
| [getLakebaseOrmConfig](Function.getLakebaseOrmConfig.md) | Get Lakebase connection configuration for ORMs that don't accept pg.Pool directly. |
| [getLakebasePgConfig](Function.getLakebasePgConfig.md) | Get Lakebase connection configuration for PostgreSQL clients. |
| [getPluginManifest](Function.getPluginManifest.md) | Loads and validates the manifest from a plugin constructor. Normalizes string type/permission to strict ResourceType/ResourcePermission. |
| [getResourceRequirements](Function.getResourceRequirements.md) | Gets the resource requirements from a plugin's manifest. |
| [getUsernameWithApiLookup](Function.getUsernameWithApiLookup.md) | Resolves the PostgreSQL username for a Lakebase connection. |
| [getWorkspaceClient](Function.getWorkspaceClient.md) | Get workspace client from config or SDK default auth chain |
| [includes](Function.includes.md) | Passes when the value contains `substring`. |
| [isFunctionTool](Function.isFunctionTool.md) | - |
| [isHostedTool](Function.isHostedTool.md) | - |
| [isJudgeConfigured](Function.isJudgeConfigured.md) | - |
| [isSQLTypeMarker](Function.isSQLTypeMarker.md) | Type guard to check if a value is a SQL type marker |
| [isToolkitEntry](Function.isToolkitEntry.md) | Type guard for `ToolkitEntry` — used by the agents plugin to differentiate toolkit references from inline tools in a mixed `tools` record. |
| [loadAgentFromFile](Function.loadAgentFromFile.md) | Loads a single markdown agent file and resolves its frontmatter against registered plugin toolkits + ambient tool library. |
| [loadAgentsFromDir](Function.loadAgentsFromDir.md) | Scans a directory for one subdirectory per agent, each containing `agent.md` (frontmatter + body). Produces an `AgentDefinition` record keyed by agent id (folder name). Throws on frontmatter errors or unresolved references. Returns an empty map if the directory does not exist. |
| [loadRootEvalConfig](Function.loadRootEvalConfig.md) | Load the root `evals.config.ts` under `rootDir` (the project root), or return `undefined` when there is none. This is the run-wide config carrying `baseUrl`/`webServer`; the CLI reads it to resolve options and manage the app-under-test lifecycle before calling [runEvalsInDir](Function.runEvalsInDir.md). |
| [matches](Function.matches.md) | Passes when the value matches `pattern`. |
| [mcpServer](Function.mcpServer.md) | Factory for declaring a custom MCP server tool. |
| [normalizeHost](Function.normalizeHost.md) | Ensure the host has a scheme (Databricks env often lacks `https://`). |
| [parseTextToolCalls](Function.parseTextToolCalls.md) | Parses text-based tool calls from model output. |
| [readEvalDataset](Function.readEvalDataset.md) | Read a Databricks managed evaluation dataset (a Unity Catalog table with `inputs`/`expectations` columns) into rows, over the public SQL Statement Execution API. Reuses SQLWarehouseConnector for submit/poll/transform — its result transform already JSON-parses string columns into objects, so `inputs`/`expectations` come back as records whether the table stores them as JSON strings or structs. |
| [reportToMlflow](Function.reportToMlflow.md) | Write one pass/fail assessment per eval result to the Databricks MLflow REST API. Never throws — failures are collected so the run still reports. |
| [resolveDatabricksAuth](Function.resolveDatabricksAuth.md) | Resolve `{host, token}` for the eval runner the same way the rest of AppKit authenticates: construct a Databricks `WorkspaceClient` and let its config mint (and later refresh) an OAuth bearer from the CLI profile — no hand-set PAT required. An explicit host/token still wins (PAT or CI env), so the SDK is only consulted for whatever isn't supplied. |
| [resolveHostedTools](Function.resolveHostedTools.md) | - |
| [resolveWorkspaceClient](Function.resolveWorkspaceClient.md) | Construct a Databricks `WorkspaceClient` for the eval runner — the object the SDK-backed connectors (e.g. `SQLWarehouseConnector`) take. An explicit host+token builds a PAT client; otherwise the profile (or ambient config) is used and the SDK resolves credentials, minting OAuth as needed. Returns `undefined` if construction throws (missing/invalid config). |
| [runAgent](Function.runAgent.md) | Standalone agent execution without `createApp`. Resolves the adapter, binds inline tools, and drives the adapter's `run()` loop to completion. |
| [runBounded](Function.runBounded.md) | Run `tasks` through a bounded worker pool and return their results in the SAME order as the input, regardless of completion order. Each task receives its input index so callers can key on it. `limit` is clamped to at least 1 (and to the task count); at `limit === 1` this is a serial loop. Individual task rejections are surfaced per-slot via `settle` rather than aborting siblings — but eval tasks never reject (failures become results). |
| [runEval](Function.runEval.md) | Run a single eval against a driver. Never throws for assertion or agent failures — those become a non-passing [EvalResult](Interface.EvalResult.md). Only a malformed eval definition surfaces as `result.error`. |
| [runEvalsInDir](Function.runEvalsInDir.md) | Discover, load, and run every eval under each agent's `evals/` dir, driving the agents on a running app. Never throws for an individual eval — load/run failures become non-passing [EvalResult](Interface.EvalResult.md)s. |
| [runWithRetries](Function.runWithRetries.md) | Run `attempt` up to `1 + retries` times, stopping as soon as it returns a result without an `error` (infra failures — thrown errors or timeouts — set `error`; assertion failures do not, so a failed-but-completed eval is returned on the first try and never retried). Returns the last result when every attempt errored. `retries` below 0 is treated as 0. |
| [summarize](Function.summarize.md) | - |
| [tool](Function.tool.md) | Factory for defining function tools with Zod schemas. |
| [toolsFromRegistry](Function.toolsFromRegistry.md) | Produces the `AgentToolDefinition[]` a ToolProvider exposes to the LLM, deriving `parameters` JSON Schema from each entry's Zod schema. |
| [userTurns](Function.userTurns.md) | Extract every user-message content, in order, from an MLflow `{"messages":[{"role":"user","content":"..."}]}` input. A dataset row can carry a full multi-turn conversation; replaying these against one thread (one `t.send` per returned string) lets the agent see the accumulating history. |
