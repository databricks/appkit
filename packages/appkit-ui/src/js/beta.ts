// Beta JS utilities -- APIs may change between minor releases.
// Import from '@databricks/appkit-ui/js' once graduated to stable.

// Database client + types. Tracks the `database` plugin, which ships at beta
// from '@databricks/appkit/beta'.
export type {
  DatabaseErrorCategory,
  DatabaseErrorDetail,
  DatabaseListPage,
} from "shared";
export {
  type DatabaseApi,
  type DatabaseRequestOptions,
  databaseApi,
} from "./database/client";
export { DatabaseApiError, type DatabaseApiErrorCode } from "./database/errors";
export type { DatabaseRegistry } from "./database/registry";
export type {
  DatabaseEntity,
  DatabaseId,
  DatabaseKeyedEntity,
  DatabaseListParams,
  DatabaseListRow,
  DatabaseRecordParams,
  DatabaseRecordRow,
} from "./database/types";
