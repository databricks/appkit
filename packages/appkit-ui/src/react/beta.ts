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

// Database operation query and mutation hooks. Track the `database` plugin,
// which ships at beta from '@databricks/appkit/beta'. The client lives in
// '@databricks/appkit-ui/js/beta'; the types the hooks mention are re-exported.
export {
  DatabaseApiError,
  type DatabaseApiErrorCode,
  type DatabaseErrorDetail,
  type DatabaseMutationName,
  type DatabaseOperationInput,
  type DatabaseOperationName,
  type DatabaseOperationOutput,
  type DatabaseQueryName,
} from "@/js/beta";
export {
  type DatabaseMutationOutcome,
  type UseDatabaseMutationResult,
  useDatabaseMutation,
} from "./hooks/use-database-mutation";
export {
  type UseDatabaseQueryOptions,
  type UseDatabaseQueryResult,
  useDatabaseQuery,
} from "./hooks/use-database-query";
