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
 * - {@link createTestPluginContext} — build a real `PluginContext` with faked edges
 *   and attach it to a plugin.
 * - {@link expectStream} — assert the ordered event types a stream emits.
 *
 * Plus the fixture helpers (`createMockRequest`, `mockServiceContext`, …) for
 * wiring up requests, responses, and the service-principal singleton.
 *
 * @example
 * ```ts
 * import { createTestPluginContext, expectStream } from "@databricks/appkit/testing";
 *
 * // Attach a real PluginContext (with faked edges) to your plugin instance,
 * // then assert on what a streaming source emits. `expectStream` consumes an
 * // async event stream, a plain array, or an SSE `Response`.
 * const mock = createTestPluginContext({ analytics: { query: fixtureRows } });
 * const plugin = new MyPlugin({});
 * await mock.attach(plugin);
 *
 * await expectStream(plugin.streamSomething(input)).toEmit(
 *   "tool_call",
 *   "message_delta",
 * );
 * ```
 *
 * @module
 */

// Re-export the PluginContext type so `TestPluginContext.ctx` is nameable
// through this entry point — the class is otherwise reachable only via a deep
// path (../core/plugin-context) that is not part of the package's exports map.
export type { PluginContext } from "../core/plugin-context";
export {
  type CapturedSSEResponse,
  type ExpectStreamOptions,
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
  createMockTelemetry,
  createMockWorkspaceClient,
  createSuccessfulSQLResponse,
  mockServiceContext,
  type OboOption,
  resetTestCache,
  runWithRequestContext,
  type ServiceContextMock,
  setupDatabricksEnv,
  type TestContextOptions,
  useServiceContextMock,
} from "./fixtures";
export {
  createTestPluginContext,
  type FakeProvider,
  type FakeProviders,
  type FakeToolResponse,
  type RecordedRoute,
  type RecordedToolCall,
  type TestPluginContext,
} from "./test-plugin-context";
