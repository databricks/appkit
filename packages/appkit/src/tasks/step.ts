import type { TaskContext } from "../../vendor/taskflow/taskflow.js";
import { InitializationError } from "../errors";
import { getCachedVendorSync } from "./vendor-loader";

/**
 * Wraps an async function as an idempotent WAL-keyed checkpoint inside
 * a durable task. On recovery, completed steps short-circuit to the
 * cached result instead of re-executing — use this for expensive /
 * unsafe-to-replay stages (LLM calls, large queries, external I/O).
 *
 * **Naming matters**: the WAL key is `Function.name`, so anonymous
 * arrows all collide on `""`. `step(fn)` requires a non-empty `.name`
 * (named declaration or `const x = step(...)` assignment);
 * `step("name", fn)` overrides it explicitly.
 *
 * Lazily resolves the engine primitive on first invocation so module-
 * scope `const x = step(...)` works before `createApp` has booted.
 *
 * @example
 * ```ts
 * const fetchInvoices = step("fetch-invoices", async (ctx, id: string) =>
 *   invoiceClient.list({ accountId: id }),
 * );
 * ```
 *
 * @public
 */
export function step<TArgs extends unknown[], TResult>(
  name: string,
  fn: (ctx: TaskContext, ...args: TArgs) => Promise<TResult>,
): (ctx: TaskContext, ...args: TArgs) => Promise<TResult>;
export function step<TArgs extends unknown[], TResult>(
  fn: (ctx: TaskContext, ...args: TArgs) => Promise<TResult>,
): (ctx: TaskContext, ...args: TArgs) => Promise<TResult>;
export function step<TArgs extends unknown[], TResult>(
  nameOrFn: string | ((ctx: TaskContext, ...args: TArgs) => Promise<TResult>),
  maybeFn?: (ctx: TaskContext, ...args: TArgs) => Promise<TResult>,
): (ctx: TaskContext, ...args: TArgs) => Promise<TResult> {
  let stepName: string;
  let target: (ctx: TaskContext, ...args: TArgs) => Promise<TResult>;
  if (typeof nameOrFn === "string") {
    if (!nameOrFn) {
      throw new Error("step(name, fn): name must be non-empty.");
    }
    if (typeof maybeFn !== "function") {
      throw new Error("step(name, fn): missing function argument.");
    }
    stepName = nameOrFn;
    const renamed = (...args: Parameters<typeof maybeFn>) => maybeFn(...args);
    Object.defineProperty(renamed, "name", { value: stepName });
    target = renamed as typeof maybeFn;
  } else {
    if (!nameOrFn.name) {
      throw new Error(
        'step(fn): wrapped function has empty `.name` — would collide with other anonymous steps in the WAL. Use `const x = step(...)` or pass an explicit name via `step("my-step", fn)`.',
      );
    }
    stepName = nameOrFn.name;
    target = nameOrFn;
  }

  let memoized:
    | ((ctx: TaskContext, ...args: TArgs) => Promise<TResult>)
    | null = null;
  const trampoline = (ctx: TaskContext, ...args: TArgs): Promise<TResult> => {
    if (!memoized) {
      const vendor = getCachedVendorSync();
      if (!vendor) {
        throw InitializationError.notInitialized(
          "TaskManager",
          `step("${stepName}") ran before the task engine initialised — call it inside a registered task body.`,
        );
      }
      memoized = vendor.workflow.step(
        target as unknown as (
          ctx: TaskContext,
          ...args: unknown[]
        ) => Promise<unknown>,
      ) as unknown as (ctx: TaskContext, ...args: TArgs) => Promise<TResult>;
    }
    return memoized(ctx, ...args);
  };
  Object.defineProperty(trampoline, "name", { value: stepName });
  return trampoline;
}
