import { Readable } from "node:stream";

import { isPlainObject } from "../utils/is-plain-object";
import type { RequestScope } from "./request-scope";

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

// Methods that would re-scope a scoped surface to another identity. Only
// these are hidden; other `as*` names (asCsv, asArrow) are ordinary exports.
const IDENTITY_METHODS: ReadonlySet<PropertyKey> = new Set(["asUser"]);

function isIdentityMethod(key: PropertyKey): boolean {
  return IDENTITY_METHODS.has(key);
}

function isNativeStream(value: unknown): boolean {
  return (
    (typeof ReadableStream !== "undefined" &&
      value instanceof ReadableStream) ||
    value instanceof Readable
  );
}

/**
 * Whether a value can run code later and so must run in the caller scope:
 * a function, a Promise, a non-native async iterable, or a plain object
 * reaching one of those through its own properties. Getter properties count,
 * and are not invoked here. Arrays and other objects are plain data, as before.
 */
function needsScope(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === "function" || value instanceof Promise) return true;
  if (!value || typeof value !== "object" || isNativeStream(value)) {
    return false;
  }
  if (Symbol.asyncIterator in value) return true;
  if (!isPlainObject(value) || seen.has(value)) return false;
  seen.add(value);
  return Reflect.ownKeys(value).some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.get !== undefined || needsScope(descriptor?.value, seen);
  });
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
  // Native streams pass through unchanged. The authenticated request already
  // ran inside the caller scope; reading the body is pure data with no
  // deferred identity work, and wrapping would strip getReader/pipe/cancel.
  if (isNativeStream(value)) {
    return value;
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
    // Plain data results come back unchanged: mutable and identity-stable.
    if (!needsScope(value)) return value;
    const result = Object.create(Object.getPrototypeOf(value));
    for (const key of Reflect.ownKeys(value)) {
      if (!preserveIdentityMethods && isIdentityMethod(key)) continue;
      Object.defineProperty(result, key, {
        enumerable: Object.getOwnPropertyDescriptor(value, key)?.enumerable,
        configurable: true,
        get: () => {
          const member = scope.run(() => Reflect.get(value, key));
          // Data members are returned as-is so repeated reads are identical.
          return needsScope(member)
            ? scopeApi(
                member,
                scope,
                receiver ?? value,
                preserveIdentityMethods,
              )
            : member;
        },
        set: (next: unknown) => {
          Reflect.set(value, key, next);
        },
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
