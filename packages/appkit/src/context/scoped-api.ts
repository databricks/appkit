import { isPlainObject } from "../utils/is-plain-object";
import type { RequestScope } from "./request-scope";

export { isPlainObject } from "../utils/is-plain-object";

const EXCLUDED_FROM_PROXY = new Set([
  "setup",
  "shutdown",
  "attachContext",
  "injectRoutes",
  "getEndpoints",
  "getSkipBodyParsingPaths",
  "abortActiveOperations",
  "clientConfig",
  "constructor",
]);

function isIdentityMethod(key: PropertyKey): boolean {
  return typeof key === "string" && /^as[A-Z]/.test(key);
}

/** Preserve identity across callable exports, returned handles, and lazy streams. */
export function scopeApi<T>(
  value: T,
  scope: RequestScope,
  receiver?: unknown,
  preserveIdentityMethods = false,
): T {
  if (typeof value === "function") {
    return new Proxy(value, {
      apply: (fn, thisArg, args) => {
        const result = scope.run(() =>
          Reflect.apply(fn, receiver ?? thisArg, args),
        );
        // Ambient resource guards must not change ordinary SP result objects.
        if (preserveIdentityMethods) return result;
        return scopeApi(result, scope);
      },
      get: (fn, key) =>
        !preserveIdentityMethods && isIdentityMethod(key)
          ? undefined
          : scopeApi(Reflect.get(fn, key), scope, fn, preserveIdentityMethods),
    });
  }
  if (value instanceof Promise) {
    return value.then((result) =>
      scopeApi(result, scope, undefined, preserveIdentityMethods),
    ) as T;
  }
  if (value && typeof value === "object" && Symbol.asyncIterator in value) {
    const iterable = value as AsyncIterable<unknown>;
    const wrapIterator = (
      iterator: AsyncIterator<unknown>,
    ): AsyncIterableIterator<unknown> => {
      const finish = iterator.return?.bind(iterator);
      const fail = iterator.throw?.bind(iterator);
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        next: (...args: [] | [unknown]) =>
          scope.run(() => iterator.next(...args)),
        ...(finish && {
          return: (result?: unknown) => scope.run(() => finish(result)),
        }),
        ...(fail && {
          throw: (error?: unknown) => scope.run(() => fail(error)),
        }),
      };
    };
    if ("next" in value && typeof value.next === "function") {
      return wrapIterator(value as AsyncIterableIterator<unknown>) as T;
    }
    return {
      [Symbol.asyncIterator]: () =>
        wrapIterator(scope.run(() => iterable[Symbol.asyncIterator]())),
    } as T;
  }
  if (isPlainObject(value)) {
    const result = Object.create(Object.getPrototypeOf(value));
    for (const key of Reflect.ownKeys(value)) {
      if (!preserveIdentityMethods && isIdentityMethod(key)) continue;
      Object.defineProperty(result, key, {
        enumerable: Object.getOwnPropertyDescriptor(value, key)?.enumerable,
        configurable: true,
        get: () =>
          scopeApi(
            scope.run(() => Reflect.get(value, key)),
            scope,
            receiver ?? value,
            preserveIdentityMethods,
          ),
      });
    }
    return result;
  }
  return value;
}

/** Compatibility adapter for direct Plugin.asUser callers. */
export function scopePlugin<T extends object>(
  plugin: T,
  scope: RequestScope,
): T {
  return new Proxy(plugin, {
    get(target, key) {
      if (isIdentityMethod(key)) return undefined;
      const value = Reflect.get(target, key, target);
      if (typeof key === "string" && EXCLUDED_FROM_PROXY.has(key)) return value;
      if (key === "exports" && typeof value === "function") {
        return () =>
          scopeApi(scope.run(() => value.call(target)) ?? {}, scope, target);
      }
      if (typeof value === "function") {
        return (...args: unknown[]) =>
          scope.run(() => Reflect.apply(value, target, args));
      }
      return scopeApi(value, scope, target);
    },
  });
}
