import { SidebarsConfig } from "@docusaurus/plugin-content-docs";
const typedocSidebar: SidebarsConfig = {
  items: [
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
          id: "api/appkit/Interface.ITelemetry",
          label: "ITelemetry"
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
        }
      ]
    },
    {
      type: "category",
      label: "Type Aliases",
      items: [
        {
          type: "doc",
          id: "api/appkit/TypeAlias.IAppRouter",
          label: "IAppRouter"
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
          id: "api/appkit/Function.isSQLTypeMarker",
          label: "isSQLTypeMarker"
        }
      ]
    }
  ]
};
export default typedocSidebar;