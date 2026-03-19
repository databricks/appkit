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
          id: "api/appkit/Class.Plugin",
          label: "Plugin"
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
          id: "api/appkit/Interface.DatabaseCredential",
          label: "DatabaseCredential"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.GenerateDatabaseCredentialRequest",
          label: "GenerateDatabaseCredentialRequest"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.ITelemetry",
          label: "ITelemetry"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.LakebasePoolConfig",
          label: "LakebasePoolConfig"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.PluginManifest",
          label: "PluginManifest"
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
          id: "api/appkit/Interface.ResourceEntry",
          label: "ResourceEntry"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.ResourceFieldEntry",
          label: "ResourceFieldEntry"
        },
        {
          type: "doc",
          id: "api/appkit/Interface.ResourceRequirement",
          label: "ResourceRequirement"
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
          id: "api/appkit/TypeAlias.ConfigSchema",
          label: "ConfigSchema"
        },
        {
          type: "doc",
          id: "api/appkit/TypeAlias.IAppRouter",
          label: "IAppRouter"
        },
        {
          type: "doc",
          id: "api/appkit/TypeAlias.PluginData",
          label: "PluginData"
        },
        {
          type: "doc",
          id: "api/appkit/TypeAlias.ResourcePermission",
          label: "ResourcePermission"
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
          id: "api/appkit/Variable.sql",
          label: "sql"
        }
      ]
    },
    {
      type: "category",
      label: "Functions",
      items: [
        {
          type: "doc",
          id: "api/appkit/Function.appKitTypesPlugin",
          label: "appKitTypesPlugin"
        },
        {
          type: "doc",
          id: "api/appkit/Function.createApp",
          label: "createApp"
        },
        {
          type: "doc",
          id: "api/appkit/Function.createLakebasePool",
          label: "createLakebasePool"
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
          id: "api/appkit/Function.isSQLTypeMarker",
          label: "isSQLTypeMarker"
        }
      ]
    }
  ]
};
export default typedocSidebar;