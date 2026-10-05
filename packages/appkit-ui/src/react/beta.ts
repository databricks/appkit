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

// AI Functions hook + types. Tracks the `aiFunctions` plugin, which ships at
// beta from '@databricks/appkit/beta'.
export type {
  AiFunctionTask,
  AiFunctionTaskInput,
  AiFunctionTaskResult,
  AiFunctionTasks,
} from "shared";
export {
  type UseAiFunctionResult,
  useAiFunction,
} from "./hooks/use-ai-function";
// Pure result helpers, shared with the server (`@databricks/appkit/beta`).
export { citedText, extractValues, scoreLevel } from "shared";
