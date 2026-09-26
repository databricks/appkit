// Beta React components -- APIs may change between minor releases.
// Import from '@databricks/appkit-ui/react' once graduated to stable.

// App Analytics browser SDK. <AppAnalytics /> configures the shared
// `appAnalytics` client, which posts to the server plugin's built-in
// /_analytics/v1/logs relay.
export { appAnalytics } from "@databricks/app-analytics";
export {
  AppAnalytics,
  type AppAnalyticsProps,
} from "@databricks/app-analytics/react";

// AI Search hook + types. Tracks the `aiSearch` plugin, which ships at beta
// from '@databricks/appkit/beta'.
export type {
  AiSearchClientConfig,
  AiSearchIndexSummary,
  AiSearchQueryType,
  AiSearchRequest,
  AiSearchResponse,
  AiSearchResult,
} from "./hooks/types";
export {
  type UseAiSearchQueryOptions,
  type UseAiSearchQueryResult,
  useAiSearchQuery,
} from "./hooks/use-ai-search-query";
