/**
 * @deprecated Internal re-export shim. The test helpers now live in the
 * shipped testing kit at `packages/appkit/src/testing/` and are published as
 * `@databricks/appkit/testing`. This file re-exports them so the existing
 * `@tools/test-helpers` importers keep working; new code (inside or outside
 * this repo) should import from `@databricks/appkit/testing` instead.
 *
 * The integration suites have already moved to the public entry point, which is
 * what verifies the published surface is self-sufficient. The remaining
 * importers are unit suites, migrated opportunistically.
 *
 * Note: `mockServiceContext` is now synchronous (the previous dynamic
 * `import()` became a static one to avoid a circular-init trap once packaged).
 * Existing `await mockServiceContext(...)` call sites are unaffected — awaiting
 * a non-promise is a no-op, and `Awaited<ReturnType<...>>` unwraps identically.
 */
export {
  createFailedSQLResponse,
  createMockRequest,
  createMockResponse,
  createMockRouter,
  createMockTelemetry,
  createMockWorkspaceClient,
  createSuccessfulSQLResponse,
  createTestPluginContext,
  expectStream,
  mockServiceContext,
  createTestApp,
  type CreateTestAppOptions,
  getListeningPort,
  getMockFn,
  type MockWorkspaceClient,
  parseSSEResponse,
  resetAppKitSingletons,
  runWithRequestContext,
  setupDatabricksEnv,
  type TestApp,
  type TestContextOptions,
  type TestRequestOptions,
  useServiceContextMock,
} from "../packages/appkit/src/testing";
