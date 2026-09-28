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

// Database read and write hooks. Track the `database` plugin, which ships at
// beta from '@databricks/appkit/beta'. The client and the registry binding live
// in '@databricks/appkit-ui/js/beta'; the types the hooks mention are
// re-exported.
export {
  DatabaseApiError,
  type DatabaseApiErrorCode,
  type DatabaseEntity,
  type DatabaseErrorDetail,
  type DatabaseId,
  type DatabaseInsert,
  type DatabaseKeyedEntity,
  type DatabaseListPage,
  type DatabaseListParams,
  type DatabaseListRow,
  type DatabaseRecordParams,
  type DatabaseRecordRow,
  type DatabaseRow,
  type DatabaseUpdate,
} from "@/js/beta";
export { invalidateDatabaseReads } from "./hooks/database-request-store";
export {
  type UseDatabaseCreateOptions,
  type UseDatabaseCreateResult,
  useDatabaseCreate,
} from "./hooks/use-database-create";
export {
  type UseDatabaseDeleteOptions,
  type UseDatabaseDeleteResult,
  useDatabaseDelete,
} from "./hooks/use-database-delete";
export {
  type UseDatabaseListOptions,
  type UseDatabaseListResult,
  useDatabaseList,
} from "./hooks/use-database-list";
export {
  type DatabaseRowShape,
  type DatabaseShape,
  serialized,
  type UseDatabaseReadOptions,
  type UseDatabaseReadResult,
} from "./hooks/use-database-read";
export {
  type UseDatabaseRecordOptions,
  type UseDatabaseRecordResult,
  useDatabaseRecord,
} from "./hooks/use-database-record";
export {
  type UseDatabaseUpdateOptions,
  type UseDatabaseUpdateResult,
  useDatabaseUpdate,
} from "./hooks/use-database-update";
export type {
  DatabaseInvalidation,
  UseDatabaseWriteOptions,
  UseDatabaseWriteState,
} from "./hooks/use-database-write";
