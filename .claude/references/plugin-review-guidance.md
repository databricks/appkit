# Plugin Review Guidance

Shared evaluation rules for any skill that reviews plugin code against the best-practices categories.

## Category Index

The canonical list of best-practices categories (defined in `plugin-best-practices.md`):

| # | Category | What to check |
|---|----------|---------------|
| 1 | Manifest Design | `manifest.json` fields, resource declarations, naming |
| 2 | Plugin Class Structure | Base class, static manifest, factory export, config, shutdown |
| 3 | Route Design | `injectRoutes()`, `this.route()`, endpoint naming, body parsing |
| 4 | Interceptor Usage | `execute()`/`executeStream()` calls, `defaults.ts`, cache keys |
| 5 | asUser / OBO Patterns | `asUser(req)`, `.obo.sql`, cache key scoping, context enforcement |
| 6 | Client Config | `clientConfig()` return value, serialization, secret exposure |
| 7 | SSE Streaming | `executeStream()`, `AsyncGenerator`, `streamManager`, shutdown |
| 8 | Testing Expectations | Co-located tests, mocking, error paths, cache key coverage |
| 9 | Type Safety | Config interface, `exports()` return type, `any` usage |

## Severity Ordering

Always order findings by severity, not by category:

1. **NEVER** findings first — security or breakage blockers
2. **MUST** findings second — correctness requirements
3. **SHOULD** findings last — quality recommendations

## Deduplication

If the same code issue is covered by guidelines in multiple categories, report it once under the most specific category and note that it also relates to the other category. Do not count it as separate findings in each category.

## Cache-Key Tracing

When evaluating cache configuration (Interceptor Usage, Category 4), the codebase uses a two-stage pattern:

1. `defaults.ts` defines partial cache config (e.g., `enabled: true, ttl: 3600`) **without** a `cacheKey`.
2. The `cacheKey` is injected at the `execute()` / `executeStream()` call site in the plugin class.

Before flagging a NEVER violation for missing `cacheKey`, trace the cache config through to every call site. Only flag if no `cacheKey` is provided at any point in the execution path.
