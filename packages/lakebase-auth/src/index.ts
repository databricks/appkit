export {
  getUsernameSync,
  getUsernameWithApiLookup,
  getWorkspaceClient,
  mapSslConfig,
  type ParsedAuthConfig,
  parseConfig,
} from "./config";
export { generateDatabaseCredential } from "./credentials";
export {
  ConfigurationError,
  LakebaseError,
  ValidationError,
} from "./errors";
export {
  type CreatePasswordProviderOptions,
  createPasswordProvider,
  DEFAULT_EARLY_REFRESH_MS,
  type PasswordProvider,
} from "./password-provider";
export {
  type GetPgConfigOptions,
  getPgConfig,
  type PgConfig,
} from "./pg-config";
export { DEFAULT_RETRY_SCHEDULE, withRetries } from "./retry";
export type {
  Credential,
  DatabaseCredential,
  DriverSslConfig,
  FetchCredential,
  GenerateDatabaseCredentialRequest,
  LakebaseAuthConfig,
  LogFn,
  LogLevel,
  RefreshMode,
  RequestedClaims,
  RequestedResource,
  RetryOptions,
  SslConfig,
} from "./types";
export { RequestedClaimsPermissionSet } from "./types";
