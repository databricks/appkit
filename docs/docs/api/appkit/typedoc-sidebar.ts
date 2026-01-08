import { SidebarsConfig } from "@docusaurus/plugin-content-docs";
const typedocSidebar: SidebarsConfig = {
  items: [
    {
      type: "category",
      label: "Classes",
      items: [
        {
          type: "doc",
          id: "api/appkit/Class.Plugin",
          label: "Plugin"
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
        },
        {
          type: "doc",
          id: "api/appkit/TypeAlias.RequestContext",
          label: "RequestContext"
        },
        {
          type: "doc",
          id: "api/appkit/TypeAlias.SQLTypeMarker",
          label: "SQLTypeMarker"
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
          id: "api/appkit/Function.getRequestContext",
          label: "getRequestContext"
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