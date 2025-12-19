import { SidebarsConfig } from "@docusaurus/plugin-content-docs";
const typedocSidebar: SidebarsConfig = {
  items: [
    {
      type: "category",
      label: "Classes",
      items: [
        {
          type: "doc",
          id: "api/appkit/classes/CacheManager",
          label: "CacheManager"
        },
        {
          type: "doc",
          id: "api/appkit/classes/Plugin",
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
          id: "api/appkit/interfaces/BasePluginConfig",
          label: "BasePluginConfig"
        },
        {
          type: "doc",
          id: "api/appkit/interfaces/ITelemetry",
          label: "ITelemetry"
        },
        {
          type: "doc",
          id: "api/appkit/interfaces/StreamExecutionSettings",
          label: "StreamExecutionSettings"
        }
      ]
    },
    {
      type: "category",
      label: "Type Aliases",
      items: [
        {
          type: "doc",
          id: "api/appkit/type-aliases/IAppRouter",
          label: "IAppRouter"
        },
        {
          type: "doc",
          id: "api/appkit/type-aliases/SQLTypeMarker",
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
          id: "api/appkit/variables/analytics",
          label: "analytics"
        },
        {
          type: "doc",
          id: "api/appkit/variables/server",
          label: "server"
        },
        {
          type: "doc",
          id: "api/appkit/variables/sql",
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
          id: "api/appkit/functions/appKitTypesPlugin",
          label: "appKitTypesPlugin"
        },
        {
          type: "doc",
          id: "api/appkit/functions/createApp",
          label: "createApp"
        },
        {
          type: "doc",
          id: "api/appkit/functions/getRequestContext",
          label: "getRequestContext"
        },
        {
          type: "doc",
          id: "api/appkit/functions/isSQLTypeMarker",
          label: "isSQLTypeMarker"
        },
        {
          type: "doc",
          id: "api/appkit/functions/toPlugin",
          label: "toPlugin"
        }
      ]
    }
  ]
};
export default typedocSidebar;