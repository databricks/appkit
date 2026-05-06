# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

### appkit (files plugin) — per-volume auth mode

* **feat(files):** add per-volume `auth` field (`VolumeConfig.auth`) and plugin-level `auth` default (`IFilesConfig.auth`) for selecting between service-principal and on-behalf-of-user execution. Resolution order: `volume.auth ?? plugin.auth ?? "service-principal"`. OBO mode wires HTTP route handlers and `VolumeHandle.asUser` through `runInUserContext` so SDK calls execute as the end user.
* **feat(files):** add `files.auth_mode` OpenTelemetry span attribute on every operation, set to either `"service-principal"` or `"on-behalf-of-user"` for trace filtering. The attribute lands on the connector's existing `files.<op>` span (no duplicate spans).
* **feat(files)!:** `appKit.files("vol").asUser(req).list()` now executes the SDK call as the **end user** (previously the SDK still ran as the service principal — only the policy user was swapped). Programmatic callers that relied on SP credentials post-`asUser(req)` must remove the `asUser` wrap.
* **fix(files):** `asUser(req)` now requires both `x-forwarded-user` AND `x-forwarded-access-token` in production; throws `AuthenticationError.missingToken` when either is missing. Previously, a request with only the user header silently fell back to SP credentials at the SDK level while the policy saw a real-user identity — a privilege-confusion bug. Dev fallback marks the policy user as `isServicePrincipal: true`.
* **fix(files):** OBO volume read responses are no longer cached. SP volume reads still cache. Trade-off: every OBO read hits the SDK; in exchange, no cross-user staleness. (Follow-up: per-(volume, path) generation counter for OBO list cache.)
* **fix(files):** write handlers (`upload`, `mkdir`, `delete`) now `await` cache invalidation before sending the HTTP response, eliminating a write→read race within the same client tick.
* **chore(files):** remove undocumented `bypassPolicy` option on `createVolumeAPI`. Zero consumers in `packages/` or `apps/`; no migration needed.

#### Honest limitation

Programmatic calls on an OBO volume **without** `asUser(req)` (i.e. `appKit.files("obo-vol").list()`) cannot synthesize a user identity and continue to execute against the service principal client at the call site. For programmatic per-user execution, use `asUser(req)`. The OBO volume default applies to **HTTP route traffic**, where the request headers are available.

# Changelog

# Changelog

# Changelog

# Changelog

# Changelog

# Changelog

# Changelog

# Changelog

## [1.0.0](https://github.com/databricks/appkit/compare/v0.30.1...v1.0.0) (2026-05-06)

### ⚠ BREAKING CHANGES

* programmatic callers of
appKit.files("vol").asUser(req).<op>() that expected the SDK call to
execute as the service principal (with only the policy seeing the
user) now see the SDK call execute as the user. Audit programmatic
asUser callers and remove the asUser wrap if SP credentials were the
desired behavior.

Co-authored-by: Isaac
Signed-off-by: Atila Fassina <atila@fassina.eu>

* feat(appkit): files.auth_mode span attribute + manifest scope JSDoc (phase 6)

Tags every Files plugin trace span with `files.auth_mode` set to either
`"service-principal"` or `"on-behalf-of-user"`, reflecting what
operationally happened (whether the SDK call ran inside
`runInUserContext`). Two complementary plumbing paths land on the same
attribute key:

- HTTP routes: route handlers compute the effective mode via a new
  `_effectiveAuthMode(req, volumeKey)` helper and thread it into the
  existing `PluginExecutionSettings.telemetryInterceptor.attributes`
  shape — `TelemetryInterceptor` already passes those attributes to
  `tracer.startActiveSpan`, so the attribute lands on the existing
  `plugin.execute` span without new infrastructure.
- Programmatic API (`exports()` SP path + `asUser` OBO path): wraps each
  VolumeAPI method in a new `_withAuthModeSpan(operation, mode, fn)`
  helper that calls `this.telemetry.startActiveSpan("files.<op>", ...)`.
  Programmatic calls previously created NO span, so this introduces new
  `files.<op>` spans on programmatic surface — a small observability
  enrichment beyond pure attribute plumbing. Spans respect the plugin's
  `traces` config; the noop tracer takes over when traces are disabled.

Updates `getResourceRequirements()` JSDoc to document the per-volume
permission split: SP volumes need the SP to hold `WRITE_VOLUME`; OBO
volumes need the end user (not the SP) to hold it. Adds a
`// TODO: extend plugin-manifest.schema.json` marker for the eventual
schema-level fix.

Phase 6 of files-per-volume-auth-mode. Phase 7 (docs, playground,
changelog) is next.

Co-authored-by: Isaac
Signed-off-by: Atila Fassina <atila@fassina.eu>

* docs(appkit): files OBO docs, playground demo, changelog (phase 7)

Final polish phase for files-per-volume-auth-mode:

JSDoc:
- Expand `VolumeConfig.auth` and `IFilesConfig.auth` with SP and OBO
  example blocks plus resolution-order notes.
- Extend `FilePolicyUser.isServicePrincipal` JSDoc with the full
  six-row matrix covering SP/OBO x HTTP/programmatic x header
  presence, including the `asUser(req)` rows.

Docs (`docs/docs/plugins/files.md`):
- New "Auth modes" section: two modes, resolution order, per-mode
  permission requirements, prod/dev OBO behavior, manifest-scope
  limitation, side-by-side config examples.
- New `usersOnly` policy example using `isServicePrincipal: false`
  and a "Policy user matrix" subsection.
- Rewrites every "all operations execute as the service principal"
  paragraph to describe both modes.
- Dedicated `asUser(req)` subsection with the honest limitation that
  programmatic OBO defaults don't apply without `asUser`.

Dev-playground:
- Server: new `obo_demo` volume with `auth: "on-behalf-of-user"` and
  a `usersOnly` policy; new smoke route `GET /policy/obo-volume`
  using `asUser(req)`. `app.yaml` gets the matching
  `DATABRICKS_VOLUME_OBO_DEMO` resource binding.
- Client: `policy-matrix.route.tsx` gets a "Per-volume OBO mode"
  section with two probes (HTTP route + programmatic smoke) so the
  end-to-end OBO path is exercisable from the UI.

Changelog:
- New `## Unreleased` section in `CHANGELOG.md` (lives above the
  release-it generated `[0.24.0]` block) covering the per-volume auth
  feature, the `files.auth_mode` span, the `asUser` SDK identity
  behavior change, the `bypassPolicy` removal, and the honest
  limitation about programmatic OBO without `asUser`.

Generated:
- `types.generated.ts` and `plugin-manifest.generated.ts` are
  regenerated formatting (line-collapsing) from `pnpm build`'s
  generator step. Content unchanged.

Backpressure: pnpm build, pnpm docs:build, pnpm check:fix,
pnpm -r typecheck, pnpm test (1666 passing) all clean.

Phase 7 of files-per-volume-auth-mode — feature is shippable.

Co-authored-by: Isaac
Signed-off-by: Atila Fassina <atila@fassina.eu>

* fix(appkit): files OBO review fixes — auth strictness, allocation, cache, spans

Addresses four findings from the multi-model review of the files OBO
feature.

1. asUser privilege confusion in production (CRITICAL, security)
   `_extractUser` now requires BOTH `x-forwarded-user` AND
   `x-forwarded-access-token` in production — throws
   `AuthenticationError.missingToken` when either is missing. Previously
   a request with the user header but no token returned a SP-wrapped
   API where the policy saw the request as a real end user
   (isServicePrincipal: undefined) but the SDK ran with SP credentials,
   so policies like `usersOnly: !user.isServicePrincipal` were
   satisfiable while wielding the SP's broader UC grants. CWE-639.
   Dev fallback now marks the returned policy user as
   `isServicePrincipal: true` and warns (was debug) so policies can't
   be tricked even in dev.

2. Double WorkspaceClient allocation per OBO request (HIGH, perf)
   New `_resolveAuthForRequest(req, volumeKey)` returns
   { mode, userCtx } and builds the UserContext at most once per
   request. `_runWithAuth(userCtx, fn)` now takes the pre-built ctx.
   Removes `_effectiveAuthMode` (no longer needed). Every OBO HTTP
   request previously constructed two WorkspaceClients; cache hits
   paid that cost too. Now: one allocation, even on cache hits.

3. Write-cache invalidation on OBO + wrong path arg (HIGH, correctness)
   Two related bugs at `_invalidateListCache`: (a) cache keys included
   `getCurrentUserId()`, so user A's write only busted user A's list
   cache — user B continued to see stale listings; (b) the `path` arg
   was the file path instead of the parent directory.

   Fix: list-cache is disabled on OBO volumes (no cross-user staleness
   possible). On SP volumes, invalidation now derives the parent
   directory via `parentDirectory()`, falling back to the `"__root__"`
   sentinel for root-level writes — matches `_handleList`'s key shape.
   Cache delete + path resolution are wrapped in best-effort try/catch
   so an invalidation failure cannot convert a successful write into
   HTTP 500.

4. Duplicate `files.<op>` spans on programmatic calls (HIGH, perf)
   `FilesConnector.<op>` already opens a `files.<op>` span via its
   `traced()` decorator. The Phase 6 `_withAuthModeSpan` opened an
   identical span on top, doubling span allocation/export volume on
   every programmatic call.

   Fix: new `runWithFilesSpanAttributes(attrs, fn)` exported from
   `connectors/files/client.ts` uses AsyncLocalStorage to make ambient
   attributes available to the connector's `traced()` decorator.
   `_withAuthModeSpan` renamed to `_withAuthModeAttributes` — no longer
   creates a span; just sets `files.auth_mode` on the connector's
   existing span via the ALS channel. Programmatic calls now produce
   exactly one `files.<op>` span. HTTP route attribute path
   (`PluginExecutionSettings.telemetryInterceptor.attributes`) is
   unchanged.

Tests: 8 new regression guards covering each fix's failure mode (1674
total, was 1666). The pre-existing `DownloadResponse` unused-import
warning is also resolved as cleanup fallout.

User-facing notes (for changelog follow-up):
- asUser(req) throws on missing token in production (was silent SP
  fallback — the previous behavior was a privilege-confusion bug).
- OBO volume reads are no longer cached. Trade-off: every OBO read
  hits the SDK; in exchange, no cross-user staleness. SP volume reads
  still cache.
- Programmatic appKit.files(vol).<op>() emits one `files.<op>` span
  instead of two. The `files.auth_mode` attribute now lands on the
  connector's existing span.

Co-authored-by: Isaac
Signed-off-by: Atila Fassina <atila@fassina.eu>

* fix(appkit): files invalidate-cache await + integration ephemeral ports

Two follow-up review fixes on top of 3f98628d.

A — _invalidateListCache not awaited (medium, correctness)
   Write handlers (_handleUpload, _handleMkdir, _handleDelete) called
   _invalidateListCache without `await`, so res.json() shipped before
   cache invalidation completed. A client that issued a follow-up
   GET /list in the same tick could hit the stale cache.

   Fix: _invalidateListCache is now genuinely `async` and all three
   call sites `await` it before sending the response. Best-effort
   try/catch around cache.delete and connector.resolvePath remains, so
   an invalidation failure cannot convert a successful write into 500.

   Regression test installs a deferred-promise cache.delete and
   asserts res.json is NOT called until the delete settles. Verified
   the test fails when the `await` is removed and passes when it is
   added back.

B — hardcoded ports in integration tests (medium, CI hygiene)
   plugin.integration.test.ts bound to fixed offsets of TEST_PORT
   (9880, 9881, 9882). Concurrent CI runs or stale test processes
   risked EADDRINUSE flakiness.

   Fix: bind `port: 0` so the OS assigns ephemeral ports. New
   getListeningPort() helper waits for the server's `listening` event
   and returns the assigned port for building localBase URLs. Chose
   port-0 over supertest because the tests build their own AppKit
   instance, hold the Server for afterAll cleanup, and use real fetch
   calls — moving to supertest would have required restructuring the
   fixture lifecycle.

Tests: 1675 (was 1674 + 1 new). typecheck + biome clean.

Co-authored-by: Isaac
Signed-off-by: Atila Fassina <atila@fassina.eu>

* fix(appkit): files plugin OBO review hardening (5 findings)

- _readPathQuery helper rejects array/object query params with 400 across
  all 7 path-bearing handlers (was: req.query.path raw-cast)
- /read streams via connector.download + size-enforcing TransformStream
  capped at maxReadSize (new VolumeConfig field, default 10MB); /read no
  longer participates in the read-tier cache
- Upload TransformStream enforces bytesReceived <= contentLength when
  declared, closing a per-user policy bypass where small Content-Length
  + larger body would exceed an approved upload size
- _enforcePolicy 401 and _handleApiError 4xx now return generic public
  bodies (Unauthorized / standard HTTP STATUS_CODES); raw error.message
  goes to server-side logs only (CWE-209)

Co-authored-by: Isaac

Co-authored-by: Orca <help@stably.ai>
Signed-off-by: Atila Fassina <atila@fassina.eu>

* fix(appkit): files /read atomic 413 + list-cache key parity for ?path=/

Two HIGH correctness findings from multi-model review of sp-files vs main:

1. /read could leak a partial 200 body before triggering 413. Once
   nodeStream.pipe(res) began, headers were sent and the size-cap
   fallback became res.destroy() mid-stream — breaking the all-or-nothing
   contract. Replaced the pipe with a bounded getReader() drain into
   chunks; on overflow we respond 413 atomically (and reader.cancel()
   the upstream), otherwise res.send(Buffer.concat(chunks, bytesRead))
   ships the body in one shot. Memory still bounded by maxReadSize.

2. _invalidateListCache deleted only "__root__" for root-level writes,
   but _handleList keys ?path=/ listings under connector.resolvePath("/").
   A client listing via ?path=/ saw stale data after a sibling write.
   Invalidator now deletes both keys (with try/catch around resolvePath
   and a no-op when it equals the sentinel).

113 plugin tests + 28 integration tests + workspace typecheck green.

Co-authored-by: Isaac
Signed-off-by: Atila Fassina <atila@fassina.eu>

* fix(appkit): files Copilot review findings — root invalidation, error msg, docs

Four findings from the GitHub Copilot review on PR #310:

1. _invalidateListCache missed absolute UC root paths. A write to
   /Volumes/<c>/<s>/<v>/foo.txt has parentDirectory("/Volumes/<c>/<s>/<v>"),
   which the prior code didn't recognize as root-level — the rootless
   "__root__" listing stayed stale. Now the invalidator computes the
   volume root via connector.resolvePath(""), recognizes it as
   root-level, and invalidates all three keys "__root__", <volumeRoot>,
   <volumeRoot>/. Replaces the previous resolvePath("/") attempt that
   was a no-op (resolvePath rejects "/" since it's not /Volumes/...).

2. _extractObiUser threw "Missing x-forwarded-access-token" in every
   non-(token && userId) production case, so a request with only the
   token (but no x-forwarded-user) got a misleading server-side error.
   Now distinguishes: !token throws "missing token", token-but-no-userId
   throws "missing user header". HTTP body remains generic "Unauthorized"
   either way.

3. docs/plugins/files.md said OBO volumes get per-user cache isolation
   automatically. Code disables read/list cache entirely on OBO
   (cross-user invalidation isn't possible with the current key scheme).
   Doc updated to match.

4. docs/plugins/files.md said asUser(req) throws when x-forwarded-user
   is absent. Code requires BOTH x-forwarded-user AND
   x-forwarded-access-token in production. Doc updated at both
   occurrences.

Tests: existing root-level invalidation test rewritten as a
parameterized matrix covering both relative ("newdir") and absolute
("/Volumes/.../newdir") root-level writes; both must invalidate
__root__ + <volumeRoot> + <volumeRoot>/. 188 plugin tests + workspace
typecheck green.

Co-authored-by: Isaac
Signed-off-by: Atila Fassina <atila@fassina.eu>

* fix(appkit): rename files plugin _extractObiUser → _extractOboUser

Typo fix per review (OBO = on-behalf-of-user, not "Obi").
Touches the declaration, the single call site in `_enforcePolicy`, and
one test-comment reference.

Co-authored-by: Isaac
Signed-off-by: Atila Fassina <atila@fassina.eu>

* docs(appkit): refresh stale _enforcePolicy NOTE about SDK identity

The NOTE claimed SDK calls "still use the service principal until a later
phase wires the actual OBO runInUserContext plumbing" — but that phase
shipped: every handler now wraps in `_runWithAuth` / `runInUserContext`
when the volume resolves to OBO. Replace the NOTE with the current truth:
the policy and SDK identities are selected separately and converge per
the policy-user matrix.

Co-authored-by: Isaac
Signed-off-by: Atila Fassina <atila@fassina.eu>

* unblock SP calls for UC in production ([#310](https://github.com/databricks/appkit/issues/310)) ([9856a6b](https://github.com/databricks/appkit/commit/9856a6b309b32f98b3c25aa03055778edb2036d4))


## [0.30.1](https://github.com/databricks/appkit/compare/v0.30.0...v0.30.1) (2026-05-06)

### appkit

* **appkit:** bind SSE streams to creator and reject cross-user reconnects ([#312](https://github.com/databricks/appkit/issues/312)) ([5bf53c0](https://github.com/databricks/appkit/commit/5bf53c0b5109efd88d223e4e5203f05d11f5c2d7))


## [0.30.0](https://github.com/databricks/appkit/compare/v0.29.0...v0.30.0) (2026-05-05)

### appkit

* **appkit:** improve Databricks auth failure UX at startup ([#342](https://github.com/databricks/appkit/issues/342)) ([ae2ba2c](https://github.com/databricks/appkit/commit/ae2ba2c5a54f3d04a9de54d94de311e71b236fd5))


## [0.29.0](https://github.com/databricks/appkit/compare/v0.28.0...v0.29.0) (2026-05-05)

### appkit

* **appkit:** shared agent types and LLM adapter implementations ([#301](https://github.com/databricks/appkit/issues/301)) ([b5b695d](https://github.com/databricks/appkit/commit/b5b695d8e6c8b1162e70661ae6a507c06389b08d))


## [0.28.0](https://github.com/databricks/appkit/compare/v0.27.1...v0.28.0) (2026-04-30)

### plugin

* **plugin:** add stability system (beta/ga) with promote command ([#264](https://github.com/databricks/appkit/issues/264)) ([1a77ce9](https://github.com/databricks/appkit/commit/1a77ce9c5b8e3306b47139e4ce891795e5ec14a1)), closes [databricks/cli#5090](https://github.com/databricks/cli/issues/5090) [#280](https://github.com/databricks/appkit/issues/280) [databricks/cli#5090](https://github.com/databricks/cli/issues/5090)

* add execution context attributes to telemetry spans ([#288](https://github.com/databricks/appkit/issues/288)) ([ae259ca](https://github.com/databricks/appkit/commit/ae259ca9fc363ef1e927e2919e8c1ee6d0d7d748)), closes [#197](https://github.com/databricks/appkit/issues/197)


## [0.27.1](https://github.com/databricks/appkit/compare/v0.27.0...v0.27.1) (2026-04-30)

### appkit

* **appkit:** harden SSE response headers in setupHeaders ([#331](https://github.com/databricks/appkit/issues/331)) ([8b90a15](https://github.com/databricks/appkit/commit/8b90a1528fe0d724ae235c6c27130c8103fb072d))


## [0.27.0](https://github.com/databricks/appkit/compare/v0.26.1...v0.27.0) (2026-04-28)

### jobs

* **jobs:** add HTTP routes, validation, streaming, and review fixes ([4e92340](https://github.com/databricks/appkit/commit/4e923408e5ff9248906bae512432b94b0815188e))

* add resource-scoped jobs plugin for Databricks Lakeflow Jobs ([7092d06](https://github.com/databricks/appkit/commit/7092d069cec3a75b8922222a1520e3236e304e1b))


## [0.26.1](https://github.com/databricks/appkit/compare/v0.26.0...v0.26.1) (2026-04-27)

* log execution errors server-side (stream, Lakebase, SQL Warehouse) ([#255](https://github.com/databricks/appkit/issues/255)) ([390d9e5](https://github.com/databricks/appkit/commit/390d9e502f996d217054fa57375ed56fc82e90f2))


## [0.26.0](https://github.com/databricks/appkit/compare/v0.25.1...v0.26.0) (2026-04-27)

* add appkit codemod on-plugins-ready CLI ([#291](https://github.com/databricks/appkit/issues/291)) ([f2f0504](https://github.com/databricks/appkit/commit/f2f05044f3216b1eafcd118bd995960c35392020))
* add onPluginsReady callback to createApp, remove autoStart ([#280](https://github.com/databricks/appkit/issues/280)) ([a06b6e3](https://github.com/databricks/appkit/commit/a06b6e392de2bab2004e7ea2ccf8bb080dfea545))


## [0.25.1](https://github.com/databricks/appkit/compare/v0.25.0...v0.25.1) (2026-04-27)

### appkit

* **appkit:** check isRetryable before retrying in interceptor ([#276](https://github.com/databricks/appkit/issues/276)) ([1c994a6](https://github.com/databricks/appkit/commit/1c994a6d99f397b56e90f1b53df06a61f02b9e82))


## [0.25.0](https://github.com/databricks/appkit/compare/v0.24.0...v0.25.0) (2026-04-23)

### files

* **files:** per-volume in-app policy enforcement ([#197](https://github.com/databricks/appkit/issues/197)) ([f54dca5](https://github.com/databricks/appkit/commit/f54dca5da5af5368c7bcb18745715b54a99d47e9))


## [0.24.0](https://github.com/databricks/appkit/compare/v0.23.0...v0.24.0) (2026-04-20)

* add AST extraction to serving type generator and move types to shared/ ([#279](https://github.com/databricks/appkit/issues/279)) ([422afb3](https://github.com/databricks/appkit/commit/422afb38aa73f8adb94e091225dc3381bd92cfcd))
* ci on main ([#277](https://github.com/databricks/appkit/issues/277)) ([30a0a24](https://github.com/databricks/appkit/commit/30a0a248e0ab6bac50e8698e33eb5c46ca957aea))
* add Vector Search plugin ([#200](https://github.com/databricks/appkit/issues/200)) ([279954e](https://github.com/databricks/appkit/commit/279954eca9a82c02af639aa006aa9f968bd60517))

### cli

* **cli:** add non-interactive flags and help examples for agent readiness ([#252](https://github.com/databricks/appkit/issues/252)) ([f803a8b](https://github.com/databricks/appkit/commit/f803a8b445fba043186407af96f7402b57e8ff6e))


## [0.23.0](https://github.com/databricks/appkit/compare/v0.22.0...v0.23.0) (2026-04-14)

### appkit

* **appkit:** add jitter to RetryInterceptor exponential backoff ([#269](https://github.com/databricks/appkit/issues/269)) ([bdf2ea3](https://github.com/databricks/appkit/commit/bdf2ea335b11b09e772081890e1e75ec778f4ec2))

* typegen queries ([#251](https://github.com/databricks/appkit/issues/251)) ([9dd7fa3](https://github.com/databricks/appkit/commit/9dd7fa36e0f76a64dbd11fac42a9c10be836b688))
* use end-user ID in OBO analytics cache key ([#268](https://github.com/databricks/appkit/issues/268)) ([a8e9f6e](https://github.com/databricks/appkit/commit/a8e9f6e4c6d3e1cfd6d7b74da2ce1772ecba1757))
* add Model Serving connector and plugin ([#239](https://github.com/databricks/appkit/issues/239)) ([9dc35f1](https://github.com/databricks/appkit/commit/9dc35f1fa9f316dd9806a3a2e3d78be8302c47c4))
* add serving type generator, Vite plugin, and UI hooks ([#240](https://github.com/databricks/appkit/issues/240)) ([c4285af](https://github.com/databricks/appkit/commit/c4285af958556fcb4770e4cfa96dd6071dee66b3))
* Improve error handling from 3P requests on interceptor ([#238](https://github.com/databricks/appkit/issues/238)) ([e72bee4](https://github.com/databricks/appkit/commit/e72bee476fa3ecccee6ad184cf930fd2b56d2ed6)), closes [#258](https://github.com/databricks/appkit/issues/258)


## [0.22.0](https://github.com/databricks/appkit/compare/v0.21.0...v0.22.0) (2026-04-09)

* correct misleading asUser() log message in development mode ([#250](https://github.com/databricks/appkit/issues/250)) ([ee05c8a](https://github.com/databricks/appkit/commit/ee05c8af61f8b63ea9a7fad8be93b4f5358fce41))
* fail typegen build when queries produce unknown result types ([#254](https://github.com/databricks/appkit/issues/254)) ([f2d44ae](https://github.com/databricks/appkit/commit/f2d44ae74e35ef8b9f5b027658690aef2efc390b))
* Genie plugin — handle in-progress messages on reload and fix message overflow ([#196](https://github.com/databricks/appkit/issues/196)) ([f94b3e2](https://github.com/databricks/appkit/commit/f94b3e230fe211c4b3406151a361477119e2af7f))
* harden cookie flags, sanitize Genie markdown output, fix remote tunnel ([#216](https://github.com/databricks/appkit/issues/216)) ([c39b88b](https://github.com/databricks/appkit/commit/c39b88bebc81abc137351ab3be54d50aa8a04e16))
* plugin client config ([#190](https://github.com/databricks/appkit/issues/190)) ([03f4b97](https://github.com/databricks/appkit/commit/03f4b977ecde284f0e920213329ed7fb67facf2d))


## [0.21.0](https://github.com/databricks/appkit/compare/v0.20.3...v0.21.0) (2026-03-17)

* allow users to change the inferred chart type ([#191](https://github.com/databricks/appkit/issues/191)) ([4c090f3](https://github.com/databricks/appkit/commit/4c090f383380b05aa304831a9bf10228e376e65d))

## [0.20.3](https://github.com/databricks/appkit/compare/v0.20.2...v0.20.3) (2026-03-16)

* remove leftover test comments ([#185](https://github.com/databricks/appkit/issues/185)) ([a1dda40](https://github.com/databricks/appkit/commit/a1dda406e4a0001c52bea8feb25f4fe1af6ba996))

## [0.20.2](https://github.com/databricks/appkit/compare/v0.20.1...v0.20.2) (2026-03-13)

* plugin types ([#181](https://github.com/databricks/appkit/issues/181)) ([832111b](https://github.com/databricks/appkit/commit/832111b6bc53947ed902c30ec74530c4beb6a88d))

## [0.20.1](https://github.com/databricks/appkit/compare/v0.20.0...v0.20.1) (2026-03-13)

### appkit-ui

* **appkit-ui:** improve text selection visibility in genie chat bubbles ([#180](https://github.com/databricks/appkit/issues/180)) ([5e81b7b](https://github.com/databricks/appkit/commit/5e81b7bd8be5e3fbe27c9597f3dbce109819f1bd))

## [0.20.0](https://github.com/databricks/appkit/compare/v0.19.1...v0.20.0) (2026-03-12)

### appkit

* **appkit:** support Lakebase Autoscaling x Apps integration natively ([#132](https://github.com/databricks/appkit/issues/132)) ([581a453](https://github.com/databricks/appkit/commit/581a4533f29f029b1e1be4e2f4bbe6c619f73ac0))

## [0.19.1](https://github.com/databricks/appkit/compare/v0.19.0...v0.19.1) (2026-03-11)

* improve Genie API error messages for access denied scenarios ([#168](https://github.com/databricks/appkit/issues/168)) ([43d92d6](https://github.com/databricks/appkit/commit/43d92d6c84461bd2271906139cf9cb8282c51431))

## [0.19.0](https://github.com/databricks/appkit/compare/v0.18.0...v0.19.0) (2026-03-11)

* Files Plugin ([#115](https://github.com/databricks/appkit/issues/115)) ([12760fe](https://github.com/databricks/appkit/commit/12760fefa64f65fbc18f5a7edd76ea4d37d77282))

## [0.18.0](https://github.com/databricks/appkit/compare/v0.17.0...v0.18.0) (2026-03-10)

### genie

* **genie:** add automatic chart visualization for query results ([#146](https://github.com/databricks/appkit/issues/146)) ([3ce8bcc](https://github.com/databricks/appkit/commit/3ce8bcc0ed4978b06f9aac53325a00cedf3772fa)), closes [#145](https://github.com/databricks/appkit/issues/145)

## [0.17.0](https://github.com/databricks/appkit/compare/v0.16.0...v0.17.0) (2026-03-10)

* lazy loading for Genie conversations ([#163](https://github.com/databricks/appkit/issues/163)) ([5dc8759](https://github.com/databricks/appkit/commit/5dc87594325222ab498bf9310318e464a48f4b1e))

## [0.16.0](https://github.com/databricks/appkit/compare/v0.15.0...v0.16.0) (2026-03-06)

* typegen concurrency ([#156](https://github.com/databricks/appkit/issues/156)) ([2e9d6e5](https://github.com/databricks/appkit/commit/2e9d6e5f4397783c747ed84f071e7e130be4fbd6))

## [0.15.0](https://github.com/databricks/appkit/compare/v0.14.1...v0.15.0) (2026-03-05)

* improve dev routes rendering ([#160](https://github.com/databricks/appkit/issues/160)) ([a9df281](https://github.com/databricks/appkit/commit/a9df28186df7ea4c839161be7af9e8648a1d918c))

## [0.14.1](https://github.com/databricks/appkit/compare/v0.14.0...v0.14.1) (2026-03-04)

* always output valid types ([#152](https://github.com/databricks/appkit/issues/152)) ([b350a46](https://github.com/databricks/appkit/commit/b350a46e8e82a17b56727738722db03a2ca42d84))

## [0.14.0](https://github.com/databricks/appkit/compare/v0.13.0...v0.14.0) (2026-03-03)

* reference databricks skills on claude file ([#151](https://github.com/databricks/appkit/issues/151)) ([7920136](https://github.com/databricks/appkit/commit/7920136822c469c54978862118f692fa95725ac2))

## [0.13.0](https://github.com/databricks/appkit/compare/v0.12.2...v0.13.0) (2026-03-03)

* add genie to template ([#153](https://github.com/databricks/appkit/issues/153)) ([bdf815a](https://github.com/databricks/appkit/commit/bdf815a87ac2a11ef1cee0618af74c8c95f66ae1))

## [0.12.2](https://github.com/databricks/appkit/compare/v0.12.1...v0.12.2) (2026-03-03)

* sdk import ([#149](https://github.com/databricks/appkit/issues/149)) ([9e1b52d](https://github.com/databricks/appkit/commit/9e1b52db63988466d28a886c44b8cf386cdd5696))

## [0.12.1](https://github.com/databricks/appkit/compare/v0.12.0...v0.12.1) (2026-03-02)

* improve `llms.txt` path generation for docs embedded in the NPM packages ([#142](https://github.com/databricks/appkit/issues/142)) ([c03dceb](https://github.com/databricks/appkit/commit/c03dceb0bb904692d0c30330d676f356ee833b34))

## [0.12.0](https://github.com/databricks/appkit/compare/v0.11.2...v0.12.0) (2026-03-02)

### appkit

* **appkit:** add Genie plugin for AI/BI space integration ([#108](https://github.com/databricks/appkit/issues/108)) ([c3581d5](https://github.com/databricks/appkit/commit/c3581d59dfaa97dc7a80245df03d3b13f2d4bb17)), closes [#116](https://github.com/databricks/appkit/issues/116)

## [0.11.2](https://github.com/databricks/appkit/compare/v0.11.1...v0.11.2) (2026-02-27)

* make warehouseId optional in ServiceContext when no plugin requires it ([#91](https://github.com/databricks/appkit/issues/91)) ([ee6aa2b](https://github.com/databricks/appkit/commit/ee6aa2bcb3cf54789adb7a10426f700e60c672af))

## [0.11.1](https://github.com/databricks/appkit/compare/v0.11.0...v0.11.1) (2026-02-26)

* handle array-returning Vite plugins in mergeConfigDedup ([#89](https://github.com/databricks/appkit/issues/89)) ([a9c3c1d](https://github.com/databricks/appkit/commit/a9c3c1d90f124053b468d0534b70e20531a718c2))

## [0.11.0](https://github.com/databricks/appkit/compare/v0.10.1...v0.11.0) (2026-02-26)

### appkit

* **appkit:** introduce Lakebase plugin ([#126](https://github.com/databricks/appkit/issues/126)) ([f4bb729](https://github.com/databricks/appkit/commit/f4bb72916e1de4e824e49b6762d3860fa2d293b3))

## [0.10.1](https://github.com/databricks/appkit/compare/v0.10.0...v0.10.1) (2026-02-25)

* generate types command ([#137](https://github.com/databricks/appkit/issues/137)) ([af8ebbf](https://github.com/databricks/appkit/commit/af8ebbf4d729483797c61addf041961f6ccf6586))

## [0.10.0](https://github.com/databricks/appkit/compare/v0.9.0...v0.10.0) (2026-02-25)

### lakebase

* **lakebase:** add ability to lookup DB username with API ([#123](https://github.com/databricks/appkit/issues/123)) ([1af3f64](https://github.com/databricks/appkit/commit/1af3f6479eb5d71e4bbbd57cbd070d9e88ce23aa))

## [0.9.0](https://github.com/databricks/appkit/compare/v0.8.0...v0.9.0) (2026-02-24)

* add plugin commands ([#110](https://github.com/databricks/appkit/issues/110)) ([ec5481d](https://github.com/databricks/appkit/commit/ec5481dea46c5a6f2d85e5942e31fa0582caefbe))

## [0.8.0](https://github.com/databricks/appkit/compare/v0.7.4...v0.8.0) (2026-02-23)

* allow overriding vite client port ([#124](https://github.com/databricks/appkit/issues/124)) ([6142ec9](https://github.com/databricks/appkit/commit/6142ec956b996b6edb7e71379328ec42be4a2aa9))

## [0.7.4](https://github.com/databricks/appkit/compare/v0.7.3...v0.7.4) (2026-02-18)

* typegen command ([#119](https://github.com/databricks/appkit/issues/119)) ([8c3735c](https://github.com/databricks/appkit/commit/8c3735c6b27c5e5cbacb81363ccaf4f6acbfd185))

## [0.7.3](https://github.com/databricks/appkit/compare/v0.7.2...v0.7.3) (2026-02-18)

* release `@databricks/lakebase` correctly, fix `appkit` dependency ([#111](https://github.com/databricks/appkit/issues/111)) ([5b6856a](https://github.com/databricks/appkit/commit/5b6856a6b42680a671cfc3e99eab3bef72803fd1))

## [0.7.2](https://github.com/databricks/appkit/compare/v0.7.1...v0.7.2) (2026-02-18)

* template sync ([#109](https://github.com/databricks/appkit/issues/109)) ([f250016](https://github.com/databricks/appkit/commit/f250016b28e24e3ce56d09a0a3d95088a689a943))

## [0.7.1](https://github.com/databricks/appkit/compare/v0.7.0...v0.7.1) (2026-02-18)

* sync template versions on release ([#105](https://github.com/databricks/appkit/issues/105)) ([4cbe826](https://github.com/databricks/appkit/commit/4cbe8266e80e4b4cfe4b4e0594c2633dcba7123a))

## [0.7.0](https://github.com/databricks/appkit/compare/v0.6.0...v0.7.0) (2026-02-17)

* introduce Lakebase Autoscaling driver ([#98](https://github.com/databricks/appkit/issues/98)) ([27b1848](https://github.com/databricks/appkit/commit/27b184886b2ab15c73f3d46f5ff9e9c6d8806c71))

## [0.6.0](https://github.com/databricks/appkit/compare/v0.5.4...v0.6.0) (2026-02-16)

### appkit

* **appkit:** plugin manifest definition ([#82](https://github.com/databricks/appkit/issues/82)) ([b40f5ca](https://github.com/databricks/appkit/commit/b40f5ca2e7a9214939c2d9bd9cea6be6bb993d53))

## [0.5.4](https://github.com/databricks/appkit/compare/v0.5.3...v0.5.4) (2026-02-12)

* surface SQL error messages in typegen DESCRIBE failures ([#94](https://github.com/databricks/appkit/issues/94)) ([75d94e7](https://github.com/databricks/appkit/commit/75d94e799ba0db79bf6e8c603b0346822ddb4560))

## [0.5.3](https://github.com/databricks/appkit/compare/v0.5.2...v0.5.3) (2026-02-10)

* run typegen automatically via npm lifecycle hooks ([#92](https://github.com/databricks/appkit/issues/92)) ([80b7a96](https://github.com/databricks/appkit/commit/80b7a96b330bbe8949a0ce981d22680458b930bf))

## [0.5.2](https://github.com/databricks/appkit/compare/v0.5.1...v0.5.2) (2026-02-04)

* skip type generation when queries directory is missing ([#84](https://github.com/databricks/appkit/issues/84)) ([76b3aa0](https://github.com/databricks/appkit/commit/76b3aa00d2ad4985330c60b4849a3ba4303c9591))

## [0.5.1](https://github.com/databricks/appkit/compare/v0.5.0...v0.5.1) (2026-02-02)

* query reads on dev-remote ([#72](https://github.com/databricks/appkit/issues/72)) ([34bb1dc](https://github.com/databricks/appkit/commit/34bb1dc6fa6a220ecb624b408701c3f73dddeac4))

## [0.5.0](https://github.com/databricks/appkit/compare/v0.4.1...v0.5.0) (2026-01-30)

* appkit exposed apis ([#69](https://github.com/databricks/appkit/issues/69)) ([822d98e](https://github.com/databricks/appkit/commit/822d98e2f607c33fd7aa72166aca86c6d0fdaea3))

## [0.4.1](https://github.com/databricks/appkit/compare/v0.4.0...v0.4.1) (2026-01-30)

* Revert "chore: bump packages in the template (#70)" (#71) ([268c8cf](https://github.com/databricks/appkit/commit/268c8cf52a243abc9f17f96425cfbdf01809e471)), closes [#70](https://github.com/databricks/appkit/issues/70) [#71](https://github.com/databricks/appkit/issues/71)

## [0.4.0](https://github.com/databricks/appkit/compare/v0.3.0...v0.4.0) (2026-01-29)

* embed `appkit` CLI and AI-targeted docs into the `appkit` and `appkit-ui` packages ([#64](https://github.com/databricks/appkit/issues/64)) ([58794e8](https://github.com/databricks/appkit/commit/58794e80a3b56e02d806507e4fbfd5519bc7aa02))

## [0.3.0](https://github.com/databricks/appkit/compare/v0.2.0...v0.3.0) (2026-01-22)

* add .obo conventions on sql files ([#61](https://github.com/databricks/appkit/issues/61)) ([00a74c1](https://github.com/databricks/appkit/commit/00a74c136ded16b17ae756e0f99f7d0efa3e9fda))

## [0.2.0](https://github.com/databricks/appkit/compare/v0.1.5...v0.2.0) (2026-01-22)

### observability

* **observability:** add structured logging ([#51](https://github.com/databricks/appkit/issues/51)) ([a827c5d](https://github.com/databricks/appkit/commit/a827c5d03b116e4905ba142d672724205f8c094e))

## [0.1.5](https://github.com/databricks/appkit/compare/v0.1.4...v0.1.5) (2026-01-08)

### appkit

* **appkit:** obo logic and api usage ([#39](https://github.com/databricks/appkit/issues/39)) ([4976b1a](https://github.com/databricks/appkit/commit/4976b1a7160749b55723894bc1d49e8ea8614598))

## [0.1.4](https://github.com/databricks/appkit/compare/v0.1.3...v0.1.4) (2025-12-26)

### appkit

* **appkit:** update llms.txt file ([#38](https://github.com/databricks/appkit/issues/38)) ([1548028](https://github.com/databricks/appkit/commit/1548028261722d9e3d0e867959367865ea840d85))

## [0.1.3](https://github.com/databricks/appkit/compare/v0.1.2...v0.1.3) (2025-12-26)

### appkit

* **appkit:** query cache generation ([#37](https://github.com/databricks/appkit/issues/37)) ([db5e266](https://github.com/databricks/appkit/commit/db5e26608a1751e795e2edb5f1c401040db089e7))

## [0.1.2](https://github.com/databricks/appkit/compare/v0.1.1...v0.1.2) (2025-12-23)

### appkit

* **appkit:** generate types ([#35](https://github.com/databricks/appkit/issues/35)) ([258b768](https://github.com/databricks/appkit/commit/258b76848b1c0aac61bf244a7a95774fb8a47479))

## [0.1.1](https://github.com/databricks/appkit/compare/v0.1.0...v0.1.1) (2025-12-23)

* one-time publish workflow ([#36](https://github.com/databricks/appkit/issues/36)) ([428053b](https://github.com/databricks/appkit/commit/428053b5b122a5e54626196d1f4d8b3de17c9370))

## [0.1.0](https://github.com/databricks/appkit/compare/v0.0.2...v0.1.0) (2025-12-23)

* automatic release ([#31](https://github.com/databricks/appkit/issues/31)) ([7867d54](https://github.com/databricks/appkit/commit/7867d547d63417e389fed5b6c2928cf63c027a7a))
* notice.md ([#30](https://github.com/databricks/appkit/issues/30)) ([6d02543](https://github.com/databricks/appkit/commit/6d02543100ef3a5fce4812eabb8c578731cfc41c))
* type-safety demo theme ([#14](https://github.com/databricks/appkit/issues/14)) ([eab85a5](https://github.com/databricks/appkit/commit/eab85a5cd1415bbd0eaca626f51bca6662372ece))
* setup basic CI pipeline for docs ([#24](https://github.com/databricks/appkit/issues/24)) ([09c73e2](https://github.com/databricks/appkit/commit/09c73e200631dfbe8b139f287755839a84fb9373))
* customize website ([#25](https://github.com/databricks/appkit/issues/25)) ([7fc05c9](https://github.com/databricks/appkit/commit/7fc05c933f79ca0126508f38bbd80ecfc188b2a6))
* new llms.txt ([#34](https://github.com/databricks/appkit/issues/34)) ([19102be](https://github.com/databricks/appkit/commit/19102be47a417b87b30b5df24774a35e00e72d5d))
* setup a Docusaurs website ([#23](https://github.com/databricks/appkit/issues/23)) ([e6b6b54](https://github.com/databricks/appkit/commit/e6b6b545a1532a7ce87475c4c3b28b8801009efb))
* add type-safe sql queries with query registry ([#11](https://github.com/databricks/appkit/issues/11)) ([58f73ad](https://github.com/databricks/appkit/commit/58f73ad6b9399a220cd260a288fc6e8f9d3ff9ba))
* appkit setup ([#22](https://github.com/databricks/appkit/issues/22)) ([68ff9e1](https://github.com/databricks/appkit/commit/68ff9e1c8324b0aa22c547a79db97d592bb69af7))
* arrow stream integration ([#16](https://github.com/databricks/appkit/issues/16)) ([3128ce3](https://github.com/databricks/appkit/commit/3128ce3e5af771394c99e283b68879e2cce60c01))
* configure Databricks client user agent ([#12](https://github.com/databricks/appkit/issues/12)) ([5560cba](https://github.com/databricks/appkit/commit/5560cbacc54d53a9f19adc0f526c500aeaa80536))
* inject config from server ([#27](https://github.com/databricks/appkit/issues/27)) ([2e792d2](https://github.com/databricks/appkit/commit/2e792d28924418222f13f6aedcb004ca238770eb))
* reexport shadcn components and theme ([#2](https://github.com/databricks/appkit/issues/2)) ([4964c07](https://github.com/databricks/appkit/commit/4964c076a4c4507b2d501fd2f1febe806192ab0a))
