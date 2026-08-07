// Beta React components -- APIs may change between minor releases.
// Import from '@databricks/appkit-ui/react' once graduated to stable.

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
