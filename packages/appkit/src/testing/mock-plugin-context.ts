import type express from "express";
import type {
  AgentToolDefinition,
  BasePlugin,
  IAppRequest,
  ToolProvider,
} from "shared";
import { CacheManager } from "../cache";
import { InMemoryStorage } from "../cache/storage";
import { PluginContext } from "../core/plugin-context";
import type { Plugin } from "../plugin";
import type { ITelemetry } from "../telemetry";
import { createMockTelemetry } from "./fixtures";

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
  | null
  | undefined;

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
 * mockPluginContext({ analytics: { query: fixtureRows } });
 * ```
 *
 * Each top-level key registers a fake {@link ToolProvider} under that plugin
 * name; each inner key becomes a tool that returns the mapped response.
 */
export type FakeProviders = Record<string, Record<string, FakeToolResponse>>;

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
   * Whether the call went through the on-behalf-of (`asUser`) path. `true`
   * proves `PluginContext.executeTool` resolved the user scope rather than
   * running as the service principal.
   */
  asUser: boolean;
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
 * The result of {@link mockPluginContext}: the real `PluginContext` plus the
 * seams a test needs to drive and inspect it.
 */
export interface MockPluginContext {
  /** The real {@link PluginContext}, constructed with mock telemetry. */
  ctx: PluginContext;
  /** The injected mock telemetry provider — assert on spans here. */
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
}

/**
 * Build a real {@link PluginContext} with faked edges for testing — no live
 * workspace, no OpenTelemetry pipeline, no network.
 *
 * The context is the *real* class, so route buffering, the tool registry,
 * timeout composition, and the on-behalf-of (`asUser`) path all run for real.
 * Only three edges are faked, matching the seams the class actually has:
 *
 * - **Telemetry** is a mock provider (the one injectable production seam).
 * - **Tool providers** are fakes registered through the existing public
 *   `registerToolProvider`; their `asUser`/`executeAgentTool` are recorded.
 * - **Routes** are captured by wrapping the public `addRoute`/`addMiddleware`.
 *
 * Nothing about `PluginContext` is reimplemented.
 *
 * @param fakes - Canned tool responses keyed by plugin then tool name.
 *
 * @example
 * ```ts
 * const mock = mockPluginContext({ analytics: { query: fixtureRows } });
 * await mock.attach(agentsPlugin);
 * // ...exercise a handler that dispatches analytics.query...
 * expect(mock.toolCalls[0]).toMatchObject({ plugin: "analytics", asUser: true });
 * ```
 */
export function mockPluginContext(
  fakes: FakeProviders = {},
): MockPluginContext {
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
    ): Promise<unknown> => {
      toolCalls.push({ plugin: name, tool: toolName, args, signal, asUser });
      const response = tools[toolName];
      if (response === undefined) {
        throw new Error(
          `mockPluginContext: plugin "${name}" has no fake tool "${toolName}". ` +
            `Available: ${Object.keys(tools).join(", ") || "(none)"}`,
        );
      }
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
        resolve(toolName, args, signal, false),
    };

    // `asUser(req)` returns a user-scoped view whose executeAgentTool records
    // that the OBO path ran — this is how executeTool's user scoping becomes
    // observable without a real user token.
    const asUser = (req: IAppRequest): ToolProvider => {
      record.asUserRequests.push(req as express.Request);
      return {
        getAgentTools: () => record.tools,
        executeAgentTool: (toolName, args, signal) =>
          resolve(toolName, args, signal, true),
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

function cacheReady(): boolean {
  try {
    CacheManager.getInstanceSync();
    return true;
  } catch {
    return false;
  }
}
