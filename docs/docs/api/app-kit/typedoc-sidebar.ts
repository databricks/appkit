import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";
const typedocSidebar: SidebarsConfig = {
  items: [
    {
      type: "category",
      label: "Classes",
      items: [
        {
          type: "doc",
          id: "api/app-kit/classes/CacheManager",
          label: "CacheManager",
        },
        {
          type: "doc",
          id: "api/app-kit/classes/Plugin",
          label: "Plugin",
        },
      ],
    },
    {
      type: "category",
      label: "Interfaces",
      items: [
        {
          type: "doc",
          id: "api/app-kit/interfaces/BasePluginConfig",
          label: "BasePluginConfig",
        },
        {
          type: "doc",
          id: "api/app-kit/interfaces/ITelemetry",
          label: "ITelemetry",
        },
        {
          type: "doc",
          id: "api/app-kit/interfaces/StreamExecutionSettings",
          label: "StreamExecutionSettings",
        },
      ],
    },
    {
      type: "category",
      label: "Type Aliases",
      items: [
        {
          type: "doc",
          id: "api/app-kit/type-aliases/IAppRouter",
          label: "IAppRouter",
        },
        {
          type: "doc",
          id: "api/app-kit/type-aliases/SQLTypeMarker",
          label: "SQLTypeMarker",
        },
      ],
    },
    {
      type: "category",
      label: "Variables",
      items: [
        {
          type: "doc",
          id: "api/app-kit/variables/analytics",
          label: "analytics",
        },
        {
          type: "doc",
          id: "api/app-kit/variables/server",
          label: "server",
        },
        {
          type: "doc",
          id: "api/app-kit/variables/sql",
          label: "sql",
        },
      ],
    },
    {
      type: "category",
      label: "Functions",
      items: [
        {
          type: "doc",
          id: "api/app-kit/functions/appKitTypesPlugin",
          label: "appKitTypesPlugin",
        },
        {
          type: "doc",
          id: "api/app-kit/functions/createApp",
          label: "createApp",
        },
        {
          type: "doc",
          id: "api/app-kit/functions/getRequestContext",
          label: "getRequestContext",
        },
        {
          type: "doc",
          id: "api/app-kit/functions/isSQLTypeMarker",
          label: "isSQLTypeMarker",
        },
        {
          type: "doc",
          id: "api/app-kit/functions/toPlugin",
          label: "toPlugin",
        },
      ],
    },
  ],
};
export default typedocSidebar;
