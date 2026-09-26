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

// Database read hooks. Track the `database` plugin, which ships at beta from
// '@databricks/appkit/beta'. The client and the registry binding live in
// '@databricks/appkit-ui/js/beta'; the types the hooks mention are re-exported.
export {
  DatabaseApiError,
  type DatabaseApiErrorCode,
  type DatabaseEntity,
  type DatabaseErrorDetail,
  type DatabaseId,
  type DatabaseKeyedEntity,
  type DatabaseListPage,
  type DatabaseListParams,
  type DatabaseListRow,
  type DatabaseRecordParams,
  type DatabaseRecordRow,
} from "@/js/beta";
export { useDatabaseList } from "./hooks/use-database-list";
export {
  type DatabaseReadOptions,
  type DatabaseReadResult,
  type DatabaseShape,
  serialized,
} from "./hooks/use-database-read";
export { useDatabaseRecord } from "./hooks/use-database-record";
