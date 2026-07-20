import { SidebarsConfig } from "@docusaurus/plugin-content-docs";
const typedocSidebar: SidebarsConfig = {
  items: [
    {
      type: "category",
      label: "Enumerations",
      items: [
        {
          type: "doc",
          id: "api/appkit/Enumeration.RequestedClaimsPermissionSet",
          label: "RequestedClaimsPermissionSet"
        },
        {
          type: "doc",
          id: "api/appkit/Enumeration.ResourceType",
          label: "ResourceType"
        }
      ]
    },
    {
      type: "category",
      label: "Classes",
      items: [
        {
          type: "doc",
          id: "api/appkit/Class.AppKitError",
          label: "AppKitError"
        },
        {
          type: "doc",
          id: "api/appkit/Class.AppKitMcpClient",
          label: "AppKitMcpClient"
        },
        {
          type: "doc",
          id: "api/appkit/Class.AuthenticationError",
          label: "AuthenticationError"
        },
        {
          type: "doc",
          id: "api/appkit/Class.ConfigurationError",
          label: "ConfigurationError"
        },
        {
          type: "doc",
          id: "api/appkit/Class.ConnectionError",
          label: "ConnectionError"
        },
        {
          type: "doc",
          id: "api/appkit/Class.DatabricksAdapter",
          label: "DatabricksAdapter"
        },
        {
          type: "doc",
          id: "api/appkit/Class.ExecutionError",
          label: "ExecutionError"
        },
        {
          type: "doc",
          id: "api/appkit/Class.InitializationError",
          label: "InitializationError"
        },
        {
          type: "doc",
          id: "api/appkit/Class.MlflowClient",
          label: "MlflowClient"
        },
        {
          type: "doc",
          id: "api/appkit/Class.Plugin",
          label: "Plugin"
        },
        {
          type: "doc",
          id: "api/appkit/Class.PolicyDeniedError",
          label: "PolicyDeniedError"
        },
        {
          type: "doc",
          id: "api/appkit/Class.ResourceRegistry",
          label: "ResourceRegistry"
        },
        {
          type: "doc",
          id: "api/appkit/Class.ServerError",
          label: "ServerError"
        },
        {
          type: "doc",
          id: "api/appkit/Class.TunnelError",
          label: "TunnelError"
        },
        {
          type: "doc",
          id: "api/appkit/Class.ValidationError",
          label: "ValidationError"
        }
      ]
    },
    {
      type: "category",
      label: "Interfaces",
      items: [
        {
          type: "doc",
          id: "api/appkit/Interface.AgentAdapter",
          label: "AgentAdapter"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.AgentDefinition",
          label: "AgentDefinition"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.AgentInput",
          label: "AgentInput"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.AgentRunContext",
          label: "AgentRunContext"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.AgentsPluginConfig",
          label: "AgentsPluginConfig"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.AgentToolDefinition",
          label: "AgentToolDefinition"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.AssertionHandle",
          label: "AssertionHandle"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.AssertionResult",
          label: "AssertionResult"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.Assessment",
          label: "Assessment"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.AutoInheritToolsConfig",
          label: "AutoInheritToolsConfig"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.BasePluginConfig",
          label: "BasePluginConfig"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.CacheConfig",
          label: "CacheConfig"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.CustomJudgeSpec",
          label: "CustomJudgeSpec"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.DatabaseCredential",
          label: "DatabaseCredential"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.DatabricksAuth",
          label: "DatabricksAuth"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.DatasetRow",
          label: "DatasetRow"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.DiscoveredEval",
          label: "DiscoveredEval"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.DiscoveredEvalConfig",
          label: "DiscoveredEvalConfig"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.DriveResult",
          label: "DriveResult"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.EndpointConfig",
          label: "EndpointConfig"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.EvalConfig",
          label: "EvalConfig"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.EvalDefinition",
          label: "EvalDefinition"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.EvalDriver",
          label: "EvalDriver"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.EvalResult",
          label: "EvalResult"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.EvalRunSummary",
          label: "EvalRunSummary"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.EvalSummary",
          label: "EvalSummary"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.EvalWebServer",
          label: "EvalWebServer"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.FilePolicyUser",
          label: "FilePolicyUser"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.FileResource",
          label: "FileResource"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.FunctionTool",
          label: "FunctionTool"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.GenerateDatabaseCredentialRequest",
          label: "GenerateDatabaseCredentialRequest"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.HttpDriverOptions",
          label: "HttpDriverOptions"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.IJobsConfig",
          label: "IJobsConfig"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.ITelemetry",
          label: "ITelemetry"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.JobAPI",
          label: "JobAPI"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.JobConfig",
          label: "JobConfig"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.JobsConnectorConfig",
          label: "JobsConnectorConfig"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.JudgeConfig",
          label: "JudgeConfig"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.JudgeScore",
          label: "JudgeScore"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.LakebasePool",
          label: "LakebasePool"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.LakebasePoolConfig",
          label: "LakebasePoolConfig"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.LakebasePoolManager",
          label: "LakebasePoolManager"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.MatchResult",
          label: "MatchResult"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.McpConnectAllResult",
          label: "McpConnectAllResult"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.Message",
          label: "Message"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.PluginManifest",
          label: "PluginManifest"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.PluginToolkitProvider",
          label: "PluginToolkitProvider"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.PostResult",
          label: "PostResult"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.PromptContext",
          label: "PromptContext"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.ReadEvalDatasetOptions",
          label: "ReadEvalDatasetOptions"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.RegisteredAgent",
          label: "RegisteredAgent"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.ReportOutcome",
          label: "ReportOutcome"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.RequestedClaims",
          label: "RequestedClaims"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.RequestedResource",
          label: "RequestedResource"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.ResolveDatabricksAuthOptions",
          label: "ResolveDatabricksAuthOptions"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.ResourceEntry",
          label: "ResourceEntry"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.ResourceRequirement",
          label: "ResourceRequirement"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.RunAgentInput",
          label: "RunAgentInput"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.RunAgentResult",
          label: "RunAgentResult"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.RunEvalOptions",
          label: "RunEvalOptions"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.RunEvalsOptions",
          label: "RunEvalsOptions"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.ServingEndpointEntry",
          label: "ServingEndpointEntry"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.ServingEndpointRegistry",
          label: "ServingEndpointRegistry"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.StreamExecutionSettings",
          label: "StreamExecutionSettings"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.TelemetryConfig",
          label: "TelemetryConfig"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.TestContext",
          label: "TestContext"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.Thread",
          label: "Thread"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.ThreadStore",
          label: "ThreadStore"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.ToolAnnotations",
          label: "ToolAnnotations"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.ToolConfig",
          label: "ToolConfig"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.ToolEntry",
          label: "ToolEntry"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.ToolkitEntry",
          label: "ToolkitEntry"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.ToolkitOptions",
          label: "ToolkitOptions"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.ToolProvider",
          label: "ToolProvider"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.ValidationResult",
          label: "ValidationResult"
        }
      ]
    },
    {
      type: "category",
      label: "Type Aliases",
      items: [
        {
          type: "doc",
          id: "api/appkit/TypeAlias.AgentEvent",
          label: "AgentEvent"
        },
        {
          type: "doc",
          id: "api/appkit/TypeAlias.AgentTool",
          label: "AgentTool"
        },
        {
          type: "doc",
          id: "api/appkit/TypeAlias.AgentTools",
          label: "AgentTools"
        },
        {
          type: "doc",
          id: "api/appkit/TypeAlias.AgentToolsFn",
          label: "AgentToolsFn"
        },
        {
          type: "doc",
          id: "api/appkit/TypeAlias.BaseSystemPromptOption",
          label: "BaseSystemPromptOption"
        },
        {
          type: "doc",
          id: "api/appkit/TypeAlias.ConfigSchema",
          label: "ConfigSchema"
        },
        {
          type: "doc",
          id: "api/appkit/TypeAlias.EvalProgress",
          label: "EvalProgress"
        },
        {
          type: "doc",
          id: "api/appkit/TypeAlias.ExecutionResult",
          label: "ExecutionResult"
        },
        {
          type: "doc",
          id: "api/appkit/TypeAlias.FileAction",
          label: "FileAction"
        },
        {
          type: "doc",
          id: "api/appkit/TypeAlias.FilePolicy",
          label: "FilePolicy"
        },
        {
          type: "doc",
          id: "api/appkit/TypeAlias.HostedTool",
          label: "HostedTool"
        },
        {
          type: "doc",
          id: "api/appkit/TypeAlias.IAppRouter",
          label: "IAppRouter"
        },
        {
          type: "doc",
          id: "api/appkit/TypeAlias.JobHandle",
          label: "JobHandle"
        },
        {
          type: "doc",
          id: "api/appkit/TypeAlias.JobsExport",
          label: "JobsExport"
        },
        {
          type: "doc",
          id: "api/appkit/TypeAlias.Matcher",
          label: "Matcher"
        },
        {
          type: "doc",
          id: "api/appkit/TypeAlias.PluginData",
          label: "PluginData"
        },
        {
          type: "doc",
          id: "api/appkit/TypeAlias.Plugins",
          label: "Plugins"
        },
        {
          type: "doc",
          id: "api/appkit/TypeAlias.ResolvedToolEntry",
          label: "ResolvedToolEntry"
        },
        {
          type: "doc",
          id: "api/appkit/TypeAlias.ResourceFieldEntry",
          label: "ResourceFieldEntry"
        },
        {
          type: "doc",
          id: "api/appkit/TypeAlias.ResourcePermission",
          label: "ResourcePermission"
        },
        {
          type: "doc",
          id: "api/appkit/TypeAlias.ServingFactory",
          label: "ServingFactory"
        },
        {
          type: "doc",
          id: "api/appkit/TypeAlias.Severity",
          label: "Severity"
        },
        {
          type: "doc",
          id: "api/appkit/TypeAlias.ToolRegistry",
          label: "ToolRegistry"
        },
        {
          type: "doc",
          id: "api/appkit/TypeAlias.ToPlugin",
          label: "ToPlugin"
        }
      ]
    },
    {
      type: "category",
      label: "Variables",
      items: [
        {
          type: "doc",
          id: "api/appkit/Variable.agents",
          label: "agents"
        },
        {
          type: "doc",
          id: "api/appkit/Variable.READ_ACTIONS",
          label: "READ_ACTIONS"
        },
        {
          type: "doc",
          id: "api/appkit/Variable.sql",
          label: "sql"
        },
        {
          type: "doc",
          id: "api/appkit/Variable.WRITE_ACTIONS",
          label: "WRITE_ACTIONS"
        }
      ]
    },
    {
      type: "category",
      label: "Functions",
      items: [
        {
          type: "doc",
          id: "api/appkit/Function.agentIdFromMarkdownPath",
          label: "agentIdFromMarkdownPath"
        },
        {
          type: "doc",
          id: "api/appkit/Function.appKitServingTypesPlugin",
          label: "appKitServingTypesPlugin"
        },
        {
          type: "doc",
          id: "api/appkit/Function.appKitTypesPlugin",
          label: "appKitTypesPlugin"
        },
        {
          type: "doc",
          id: "api/appkit/Function.buildAssessments",
          label: "buildAssessments"
        },
        {
          type: "doc",
          id: "api/appkit/Function.configureJudge",
          label: "configureJudge"
        },
        {
          type: "doc",
          id: "api/appkit/Function.createAgent",
          label: "createAgent"
        },
        {
          type: "doc",
          id: "api/appkit/Function.createApp",
          label: "createApp"
        },
        {
          type: "doc",
          id: "api/appkit/Function.createHttpDriver",
          label: "createHttpDriver"
        },
        {
          type: "doc",
          id: "api/appkit/Function.createLakebasePool",
          label: "createLakebasePool"
        },
        {
          type: "doc",
          id: "api/appkit/Function.createLakebasePoolManager",
          label: "createLakebasePoolManager"
        },
        {
          type: "doc",
          id: "api/appkit/Function.defineEval",
          label: "defineEval"
        },
        {
          type: "doc",
          id: "api/appkit/Function.defineEvalConfig",
          label: "defineEvalConfig"
        },
        {
          type: "doc",
          id: "api/appkit/Function.defineTool",
          label: "defineTool"
        },
        {
          type: "doc",
          id: "api/appkit/Function.discoverEvalConfigs",
          label: "discoverEvalConfigs"
        },
        {
          type: "doc",
          id: "api/appkit/Function.discoverEvalFiles",
          label: "discoverEvalFiles"
        },
        {
          type: "doc",
          id: "api/appkit/Function.equals",
          label: "equals"
        },
        {
          type: "doc",
          id: "api/appkit/Function.evalGlyph",
          label: "evalGlyph"
        },
        {
          type: "doc",
          id: "api/appkit/Function.executeFromRegistry",
          label: "executeFromRegistry"
        },
        {
          type: "doc",
          id: "api/appkit/Function.extractServingEndpoints",
          label: "extractServingEndpoints"
        },
        {
          type: "doc",
          id: "api/appkit/Function.findRootEvalConfig",
          label: "findRootEvalConfig"
        },
        {
          type: "doc",
          id: "api/appkit/Function.findServerFile",
          label: "findServerFile"
        },
        {
          type: "doc",
          id: "api/appkit/Function.formatEvalDetail",
          label: "formatEvalDetail"
        },
        {
          type: "doc",
          id: "api/appkit/Function.formatEvalHeadline",
          label: "formatEvalHeadline"
        },
        {
          type: "doc",
          id: "api/appkit/Function.formatEvalResults",
          label: "formatEvalResults"
        },
        {
          type: "doc",
          id: "api/appkit/Function.formatResultsJson",
          label: "formatResultsJson"
        },
        {
          type: "doc",
          id: "api/appkit/Function.formatResultsJUnit",
          label: "formatResultsJUnit"
        },
        {
          type: "doc",
          id: "api/appkit/Function.formatSummaryLine",
          label: "formatSummaryLine"
        },
        {
          type: "doc",
          id: "api/appkit/Function.functionToolToDefinition",
          label: "functionToolToDefinition"
        },
        {
          type: "doc",
          id: "api/appkit/Function.generateDatabaseCredential",
          label: "generateDatabaseCredential"
        },
        {
          type: "doc",
          id: "api/appkit/Function.getExecutionContext",
          label: "getExecutionContext"
        },
        {
          type: "doc",
          id: "api/appkit/Function.getLakebaseOrmConfig",
          label: "getLakebaseOrmConfig"
        },
        {
          type: "doc",
          id: "api/appkit/Function.getLakebasePgConfig",
          label: "getLakebasePgConfig"
        },
        {
          type: "doc",
          id: "api/appkit/Function.getPluginManifest",
          label: "getPluginManifest"
        },
        {
          type: "doc",
          id: "api/appkit/Function.getResourceRequirements",
          label: "getResourceRequirements"
        },
        {
          type: "doc",
          id: "api/appkit/Function.getUsernameWithApiLookup",
          label: "getUsernameWithApiLookup"
        },
        {
          type: "doc",
          id: "api/appkit/Function.getWorkspaceClient",
          label: "getWorkspaceClient"
        },
        {
          type: "doc",
          id: "api/appkit/Function.includes",
          label: "includes"
        },
        {
          type: "doc",
          id: "api/appkit/Function.isFunctionTool",
          label: "isFunctionTool"
        },
        {
          type: "doc",
          id: "api/appkit/Function.isHostedTool",
          label: "isHostedTool"
        },
        {
          type: "doc",
          id: "api/appkit/Function.isJudgeConfigured",
          label: "isJudgeConfigured"
        },
        {
          type: "doc",
          id: "api/appkit/Function.isSQLTypeMarker",
          label: "isSQLTypeMarker"
        },
        {
          type: "doc",
          id: "api/appkit/Function.isToolkitEntry",
          label: "isToolkitEntry"
        },
        {
          type: "doc",
          id: "api/appkit/Function.loadAgentFromFile",
          label: "loadAgentFromFile"
        },
        {
          type: "doc",
          id: "api/appkit/Function.loadAgentsFromDir",
          label: "loadAgentsFromDir"
        },
        {
          type: "doc",
          id: "api/appkit/Function.loadRootEvalConfig",
          label: "loadRootEvalConfig"
        },
        {
          type: "doc",
          id: "api/appkit/Function.matches",
          label: "matches"
        },
        {
          type: "doc",
          id: "api/appkit/Function.mcpServer",
          label: "mcpServer"
        },
        {
          type: "doc",
          id: "api/appkit/Function.normalizeHost",
          label: "normalizeHost"
        },
        {
          type: "doc",
          id: "api/appkit/Function.parseTextToolCalls",
          label: "parseTextToolCalls"
        },
        {
          type: "doc",
          id: "api/appkit/Function.readEvalDataset",
          label: "readEvalDataset"
        },
        {
          type: "doc",
          id: "api/appkit/Function.reportToMlflow",
          label: "reportToMlflow"
        },
        {
          type: "doc",
          id: "api/appkit/Function.resolveDatabricksAuth",
          label: "resolveDatabricksAuth"
        },
        {
          type: "doc",
          id: "api/appkit/Function.resolveHostedTools",
          label: "resolveHostedTools"
        },
        {
          type: "doc",
          id: "api/appkit/Function.resolveWorkspaceClient",
          label: "resolveWorkspaceClient"
        },
        {
          type: "doc",
          id: "api/appkit/Function.runAgent",
          label: "runAgent"
        },
        {
          type: "doc",
          id: "api/appkit/Function.runBounded",
          label: "runBounded"
        },
        {
          type: "doc",
          id: "api/appkit/Function.runEval",
          label: "runEval"
        },
        {
          type: "doc",
          id: "api/appkit/Function.runEvalsInDir",
          label: "runEvalsInDir"
        },
        {
          type: "doc",
          id: "api/appkit/Function.runWithRetries",
          label: "runWithRetries"
        },
        {
          type: "doc",
          id: "api/appkit/Function.summarize",
          label: "summarize"
        },
        {
          type: "doc",
          id: "api/appkit/Function.tool",
          label: "tool"
        },
        {
          type: "doc",
          id: "api/appkit/Function.toolsFromRegistry",
          label: "toolsFromRegistry"
        },
        {
          type: "doc",
          id: "api/appkit/Function.userTurns",
          label: "userTurns"
        }
      ]
    }
  ]
};
export default typedocSidebar;