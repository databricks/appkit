/**
 * @packageDocumentation
 *
 * `@databricks/appkit/testing` — test an AppKit app without a live workspace.
 *
 * The kit is deterministic and network-free: it wraps the real
 * {@link PluginContext} with faked edges (mock telemetry, fake tool providers,
 * a stubbed on-behalf-of path) so a plugin's real code paths — route
 * buffering, tool dispatch, timeout composition, user scoping — run under test
 * with no credentials.
 *
 * Two entry points:
 * - {@link mockPluginContext} — build a real `PluginContext` with faked edges
 *   and attach it to a plugin.
 * - {@link expectStream} — assert the ordered event types a stream emits.
 *
 * Plus the fixture helpers (`createMockRequest`, `mockServiceContext`, …) for
 * wiring up requests, responses, and the service-principal singleton.
 *
 * @example
 * ```ts
 * import { mockPluginContext, expectStream } from "@databricks/appkit/testing";
 *
 * const mock = mockPluginContext({ analytics: { query: fixtureRows } });
 * await mock.attach(agentsPlugin);
 * await expectStream(agentsPlugin._handleStream(req, res)).toEmit(
 *   "tool_call",
 *   "message_delta",
 * );
 * ```
 *
 * @module
 */

export {
  expectStream,
  parseSSEResponse,
  type StreamAssertion,
  type StreamEvent,
  type StreamSource,
} from "./expect-stream";
export {
  createConfigurableMockWorkspaceClient,
  createFailedSQLResponse,
  createMockRequest,
  createMockResponse,
  createMockRouter,
  createMockServiceContext,
  createMockTelemetry,
  createMockUserContext,
  createMockWorkspaceClient,
  createSuccessfulSQLResponse,
  mockServiceContext,
  runWithRequestContext,
  setupDatabricksEnv,
  type TestContextOptions,
} from "./fixtures";
export {
  type FakeProvider,
  type FakeProviders,
  type FakeToolResponse,
  type MockPluginContext,
  mockPluginContext,
  type RecordedRoute,
  type RecordedToolCall,
} from "./mock-plugin-context";
