import type express from "express";
import type {
  AgentToolDefinition,
  BasePlugin,
  IAppRequest,
  ToolProvider,
} from "shared";
import { afterEach } from "vitest";

import { CacheManager } from "../cache";
import { InMemoryStorage } from "../cache/storage";
import { isToolProvider, PluginContext } from "../core/plugin-context";
import { AuthenticationError } from "../errors";
import type { Plugin } from "../plugin";
import type { ITelemetry } from "../telemetry";
import {
  createMockTelemetry,
  mockServiceContext,
  type ServiceContextMock,
} from "./fixtures";
import { createMockWorkspaceClient } from "./mock-workspace-client";

/**
 * A concrete (non-function) fake tool response — returned as-is. Covers the
 * JSON-serializable shapes a tool call yields (rows, objects, primitives,
 * nullish). A bare `unknown` is intentionally not used here: unioned with the
 * function form below it would collapse to `unknown` and strip contextual
 * types from the callback's parameters.
 */
type FakeToolValue =
  | Record<string, unknown>
  | unknown[]
  | string
  | number
  | boolean
  | null;

/**
 * A canned tool response. Either a static {@link FakeToolValue} returned
 * as-is, or a function of the call arguments (and the abort signal
 * `PluginContext.executeTool` composes) so a fake can assert on inputs or
 * simulate slow/aborting work. Returning a promise is supported (the return
 * type is intentionally `unknown`, which also covers `Promise<...>`).
 */
export type FakeToolResponse =
  | FakeToolValue
  | ((args: unknown, signal?: AbortSignal) => unknown);

/**
 * Fake connector responses, keyed by plugin name and then tool name:
 *
 * ```ts
 * createTestPluginContext({ analytics: { query: fixtureRows } });
 * ```
 *
 * Each top-level key registers a fake {@link ToolProvider} under that plugin
 * name; each inner key becomes a tool that returns the mapped response.
 */
export type FakeProviders = Record<string, Record<string, FakeToolResponse>>;

/**
 * Options for {@link createTestPluginContext} when called with a second parameter.
 * When provided, `createTestPluginContext` installs a service context seeded
 * from a mock workspace client, plus optional environment variables.
 */
export interface TestPluginContextOptions {
  /**
   * Responses keyed by dotted path (`"jobs.getRun"`) for the mocked workspace
   * client. Passed directly to {@link createMockWorkspaceClient}.
   */
  responses?: Record<string, unknown>;
  /**
   * Environment variables to set for the test. Captured on entry, restored
   * (or deleted if they were unset) on exit via an `afterEach` hook and/or
   * explicit {@link TestPluginContext.restore}.
   */
  env?: Record<string, string>;
  /**
   * If `true`, throw when a workspace client path with no declared response is
   * called, instead of resolving `undefined`. Defaults to `false` (never crash).
   */
  strict?: boolean;
}

/** A single dispatch observed by a fake provider. */
export interface RecordedToolCall {
  /** Registered plugin name (the key in {@link FakeProviders}). */
  plugin: string;
  /** Tool name passed to `executeAgentTool`. */
  tool: string;
  /** Arguments the tool received. */
  args: unknown;
  /** The abort signal `executeTool` composed (timeout ∘ caller). */
  signal?: AbortSignal;
  /**
   * Whether the dispatch was resolved through the on-behalf-of (`asUser`)
   * path. `PluginContext.executeTool` always calls `provider.asUser(req)`, so
   * for a tool reached through `executeTool` this is `true` — and, because the
   * fake `asUser` enforces the same token precondition as the real
   * {@link Plugin.asUser}, a request with no `x-forwarded-access-token` makes
   * that call **throw** rather than record `asUser: true`. The meaningful
   * assertions are therefore: a well-formed request records `asUser: true`
   * with {@link userId} set, and a token-less request rejects.
   *
   * The fake replicates the token precondition only, not the real dev-mode
   * OTel `isDevOboFallback()` marker — assert OBO here, not via that flag.
   */
  asUser: boolean;
  /**
   * The user the on-behalf-of scope resolved to (from `x-forwarded-user`), or
   * `undefined` for a service-principal call (`asUser: false`). Lets a test
   * assert the tool ran as the expected end user, not just that OBO was used.
   */
  userId?: string;
}

/** A single route registered through the context's `addRoute`/`addMiddleware`. */
export interface RecordedRoute {
  method: string;
  path: string;
  /**
   * The raw handlers as passed to `addRoute` — before `PluginContext` wraps
   * them with `forwardAsyncErrors`. Recorded here so aliasing assertions
   * ("both routes mount the same handler") can compare the original
   * references, which the wrapped express-level handlers no longer share.
   */
  handlers: express.RequestHandler[];
}

/** A fake tool provider registered on a mock context. */
export interface FakeProvider {
  /** Every `asUser(req)` the context resolved for this provider. */
  asUserRequests: express.Request[];
  /** Definitions returned from `getAgentTools()`. */
  tools: AgentToolDefinition[];
}

/**
 * The result of {@link createTestPluginContext}: the real `PluginContext` plus the
 * seams a test needs to drive and inspect it.
 */
export interface TestPluginContext {
  /** The real {@link PluginContext}, constructed with mock telemetry. */
  ctx: PluginContext;
  /**
   * The mock telemetry provider injected into the {@link PluginContext}.
   * Captures the spans the *context* opens (notably `executeTool`) — not the
   * plugin's own spans: `attachContext` rebuilds the plugin's `this.telemetry`
   * from the real `TelemetryManager`, so plugin-internal spans do not land here.
   */
  telemetry: ITelemetry;
  /**
   * Tool dispatches observed across all fake providers, in call order. Live —
   * read it after the action under test runs.
   */
  toolCalls: RecordedToolCall[];
  /**
   * Routes registered through the context, in registration order. Live —
   * populated when the plugin calls `addRoute`/`addMiddleware`.
   */
  routes: RecordedRoute[];
  /** Fake providers by plugin name, for direct assertions. */
  providers: Map<string, FakeProvider>;
  /**
   * Register (or replace) a fake tool provider after construction.
   * Same shape as one {@link FakeProviders} entry.
   */
  registerProvider(name: string, tools: Record<string, FakeToolResponse>): void;
  /**
   * Attach this context to a plugin the production way: seed an in-memory
   * cache (if AppKit hasn't already), then call `plugin.attachContext`, which
   * also rebuilds the plugin's telemetry and flips `isReady` to `true`. Await
   * it before exercising handlers that read `this.context`, `this.cache`, or
   * gate on `isReady`. Returns the same plugin for chaining.
   */
  attach<P extends Plugin>(plugin: P): Promise<P>;
  /**
   * Restore the service context and environment variables to their pre-test state.
   * Called automatically via `afterEach` when options were provided to
   * `createTestPluginContext`. Can also be called explicitly for escape hatches
   * (e.g., cleanup inside a test body). Idempotent — safe to call multiple times.
   * Only present if the context was created with options.
   */
  restore?: () => void;
}

/**
 * Build a real {@link PluginContext} with faked edges for testing — no live
 * workspace, no OpenTelemetry pipeline, no network.
 *
 * The context is the *real* class, so route buffering, the tool registry,
 * timeout composition, and the on-behalf-of (`asUser`) path all run for real.
 * Only three edges are faked, matching the seams the class actually has:
 *
 * - **Telemetry** is a mock provider injected into the context (the one
 *   injectable production seam); it records the context's own spans, not the
 *   plugin's.
 * - **Tool providers** are fakes registered through the existing public
 *   `registerToolProvider`; their `asUser`/`executeAgentTool` are recorded.
 * - **Routes** are captured by wrapping the public `addRoute`/`addMiddleware`.
 *
 * Nothing about `PluginContext` is reimplemented.
 *
 * @param fakes - Canned tool responses keyed by plugin then tool name.
 * @param options - When provided, installs a mock workspace client seeded from
 *   `responses`, mocks the service context, and sets `env`. Omit it for the
 *   original behavior.
 *
 * @example
 * ```ts
 * // No options
 * const mock = createTestPluginContext({ analytics: { query: fixtureRows } });
 * await mock.attach(agentsPlugin);
 * // ...exercise a handler that dispatches analytics.query...
 * expect(mock.toolCalls[0]).toMatchObject({ plugin: "analytics", asUser: true });
 *
 * // With options — installs service context + seeded client
 * const mock = createTestPluginContext(
 *   {},
 *   { responses: { "jobs.getRun": { state: "DONE" } } },
 * );
 * ```
 */
export function createTestPluginContext(
  fakes: FakeProviders = {},
  options?: TestPluginContextOptions,
): TestPluginContext {
  // No options: original behavior.
  if (!options) {
    return createTestPluginContextSync(fakes);
  }

  // Options provided: install the seeded client, service context, and scoped env.
  return createTestPluginContextWithOptions(fakes, options);
}

function createTestPluginContextSync(fakes: FakeProviders): TestPluginContext {
  const telemetry = createMockTelemetry();
  const ctx = new PluginContext({ telemetry });

  const toolCalls: RecordedToolCall[] = [];
  const routes: RecordedRoute[] = [];
  const providers = new Map<string, FakeProvider>();

  // Wrap the public route API so raw (pre-wrap) handlers are inspectable while
  // the real buffering/flush path stays intact.
  const realAddRoute = ctx.addRoute.bind(ctx);
  ctx.addRoute = (
    method: string,
    path: string,
    ...handlers: express.RequestHandler[]
  ): void => {
    routes.push({ method, path, handlers });
    realAddRoute(method, path, ...handlers);
  };
  const realAddMiddleware = ctx.addMiddleware.bind(ctx);
  ctx.addMiddleware = (
    path: string,
    ...handlers: express.RequestHandler[]
  ): void => {
    routes.push({ method: "use", path, handlers });
    realAddMiddleware(path, ...handlers);
  };

  function registerProvider(
    name: string,
    tools: Record<string, FakeToolResponse>,
  ): void {
    const record: FakeProvider = {
      asUserRequests: [],
      tools: Object.keys(tools).map((toolName) => ({
        name: toolName,
        description: `Fake tool ${name}.${toolName}`,
        parameters: { type: "object" },
      })),
    };
    providers.set(name, record);

    const resolve = async (
      toolName: string,
      args: unknown,
      signal: AbortSignal | undefined,
      asUser: boolean,
      userId: string | undefined,
    ): Promise<unknown> => {
      toolCalls.push({
        plugin: name,
        tool: toolName,
        args,
        signal,
        asUser,
        userId,
      });
      // `Object.hasOwn`, not `tools[toolName] === undefined`: a tool named
      // "constructor"/"toString"/etc. would otherwise resolve to an inherited
      // Object.prototype method and be invoked instead of reported missing.
      if (!Object.hasOwn(tools, toolName)) {
        throw new Error(
          `createTestPluginContext: plugin "${name}" has no fake tool "${toolName}". ` +
            `Available: ${Object.keys(tools).join(", ") || "(none)"}`,
        );
      }
      const response = tools[toolName];
      return typeof response === "function"
        ? await (response as (a: unknown, s?: AbortSignal) => unknown)(
            args,
            signal,
          )
        : response;
    };

    const base: ToolProvider = {
      getAgentTools: () => record.tools,
      executeAgentTool: (toolName, args, signal) =>
        resolve(toolName, args, signal, false, undefined),
    };

    // Mirror the real `Plugin.asUser` token precondition (plugin.ts) so the
    // recorded `asUser` flag reflects genuine user-scope resolution rather than
    // being unconditionally true: a request with no `x-forwarded-access-token`
    // throws `missingToken` (production behavior), except in development where
    // the real code skips impersonation. This is edge-faking of asUser's
    // *contract*, not a reimplementation of `runInUserContext`/`ServiceContext`.
    //
    // Deliberately NOT reproduced: the real dev-mode path sets an OTel
    // `DEV_OBO_FALLBACK_KEY` marker (read by `isDevOboFallback()`). That key is
    // module-private telemetry plumbing; assert OBO via the recorded
    // `asUser`/`userId` fields, not `isDevOboFallback()`.
    const asUser = (req: IAppRequest): ToolProvider => {
      record.asUserRequests.push(req as express.Request);
      const token = (req as express.Request)
        .header?.("x-forwarded-access-token")
        ?.trim();
      const userId = (req as express.Request)
        .header?.("x-forwarded-user")
        ?.trim();
      const isDev = process.env.NODE_ENV === "development";

      if (!token && !isDev) {
        throw AuthenticationError.missingToken("user token");
      }
      if (token && !userId && !isDev) {
        throw AuthenticationError.missingUserId();
      }

      return {
        ...base,
        executeAgentTool: (toolName, args, signal) =>
          resolve(toolName, args, signal, true, userId),
      };
    };

    // `registerToolProvider` expects the full ToolProviderPlugin shape
    // (BasePlugin & ToolProvider & { asUser }). executeTool only ever calls
    // `asUser` and `executeAgentTool`; the remaining BasePlugin surface is
    // never touched for a registered provider, so a focused fake plus a cast
    // is sufficient and avoids reimplementing a plugin.
    const provider = {
      name,
      setup: async () => {},
      injectRoutes: () => {},
      getEndpoints: () => ({}),
      ...base,
      asUser,
    } as unknown as BasePlugin &
      ToolProvider & {
        asUser: (req: IAppRequest) => ToolProvider;
      };

    ctx.registerToolProvider(name, provider);
  }

  for (const [name, tools] of Object.entries(fakes)) {
    registerProvider(name, tools);
  }

  async function attach<P extends Plugin>(plugin: P): Promise<P> {
    // Seed a real in-memory cache if AppKit hasn't initialized one. Idempotent:
    // getInstance returns any existing singleton (e.g. one a suite already set
    // up) and ignores the storage argument in that case.
    if (!cacheReady()) {
      await CacheManager.getInstance({ storage: new InMemoryStorage({}) });
    }
    plugin.attachContext({ context: ctx });

    // Mirror what AppKit core does after attachContext (core/appkit.ts): put
    // the plugin in the registry so `getPlugins()`/`getPluginNames()`/
    // `hasPlugin()` and any sibling-plugin lookup behave as in production. Only
    // register it as a tool provider when it actually is one AND its name does
    // not collide with an injected fake — the fakes are the authored test
    // doubles and must not be overwritten by the plugin under test.
    ctx.registerPlugin(plugin.name, plugin as unknown as BasePlugin);
    if (isToolProvider(plugin) && !providers.has(plugin.name)) {
      ctx.registerToolProvider(
        plugin.name,
        plugin as unknown as Parameters<typeof ctx.registerToolProvider>[1],
      );
    }
    return plugin;
  }

  return {
    ctx,
    telemetry,
    toolCalls,
    routes,
    providers,
    registerProvider,
    attach,
  };
}

function createTestPluginContextWithOptions(
  fakes: FakeProviders,
  options: TestPluginContextOptions,
): TestPluginContext {
  const { responses = {}, env: envVars = {}, strict = false } = options;

  // Build a mock workspace client seeded from responses
  const client = createMockWorkspaceClient({
    responses,
    strict,
  });

  // Install the mock service context with the seeded client
  const serviceContextMock = mockServiceContext({
    serviceDatabricksClient: client,
  });

  // Capture prior env values (including "was unset")
  const priorEnv = new Map<string, string | undefined>();
  for (const key of Object.keys(envVars)) {
    priorEnv.set(key, process.env[key]);
  }

  // Set the env vars
  Object.assign(process.env, envVars);

  // Create the base context (without options this time, since we're handling everything)
  const base = createTestPluginContextSync(fakes);

  // Restore function: restores env and service context (idempotent)
  let hasRestored = false;
  const restore = () => {
    if (hasRestored) return;
    hasRestored = true;

    // Restore env vars
    for (const [key, value] of priorEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    // Restore service context
    serviceContextMock.restore();
  };

  // Register an afterEach to auto-restore when used in a test
  // This allows cleanup to happen automatically after the test
  afterEach(() => {
    restore();
  });

  // Return the context with the restore method
  return {
    ...base,
    restore,
  };
}

function cacheReady(): boolean {
  try {
    CacheManager.getInstanceSync();
    return true;
  } catch {
    return false;
  }
}
