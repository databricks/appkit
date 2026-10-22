# 002 - Database route operations

| | |
|---|---|
| **Status** | Draft, awaiting operator validation |
| **Owner** | Victor Ditadi |

[Google Doc](https://docs.google.com/document/d/1zO0X7bCwYtmX6m-p7DFGZJneSa5OsgVd5nctGhCdVZY/edit)
is the comment copy. Approved edits there are synced to this file.

This proposal lets an app author expose a database operation without duplicating column types or Zod validators.
Authorization stays explicit. The database plugin exposes nothing by default. For an authored operation, the table
and HTTP method infer the ordinary input and public response. Custom contracts are optional overrides.

Every new API below is proposed. No example has been compiled or run. This PR changes only this design document.
Implementation planning and implementation wait for operator validation.

## Background and motivation

At baseline `670764d742db6963da9d6929da58560cce18e228`, `database()` loads `config/database/schema.ts` and publishes
`appkit.database`. There is no `config/schema.ts` or `appkit.db`. Its HTTP registration has a different safety model
from its trusted server API.

| Area | Current behavior | Source |
|---|---|---|
| Exposure | An omitted `api`, `true`, or `{}` enables generated CRUD for all declared tables. `{ tables }` also enables writes unless narrowed separately. `false` disables HTTP only. | `packages/appkit/src/plugins/database/crud/exposure.ts:93-146` |
| Routes | `injectRoutes` registers list, detail, create, update, and delete handlers without per-user authorization. | `packages/appkit/src/plugins/database/database.ts:126-184`, `packages/appkit/src/plugins/database/crud/routes.ts` |
| Credentials | One Lakebase pool uses the app's service principal. Request context never implicitly changes that credential. | `packages/appkit/src/connectors/lakebase/index.ts:29-62` |
| Identity | `createRequestScope` copies forwarded headers and has development fallbacks. It does not establish the proxy's header-stripping contract. | `packages/appkit/src/context/request-scope.ts:26-73` |
| OBO | `database` and `postgres` are app-only resources. Database execution inside an ordinary caller scope fails with `APP_ONLY_RESOURCE`. | `packages/shared/src/schemas/manifest.ts:69-73`, `packages/appkit/src/context/resource-capabilities.ts:63-77` |
| Validation | Trusted insert and update schemas admit private columns. The narrower HTTP capabilities still grow with public columns. | `packages/appkit/src/database/schema-builder/validators.ts:46-71`, `packages/appkit/src/plugins/database/crud/capabilities.ts:32-55` |
| Execution | Interceptors run cache, retry, timeout, telemetry, then the callback. Cache can bypass the callback. Database defaults disable retry and do not enable a result cache. | `packages/appkit/src/plugin/plugin.ts:556-611`, `packages/appkit/src/plugins/database/defaults.ts` |
| Errors | The shared database error vocabulary lacks 401. Generic execution and telemetry can observe an exception before the HTTP handler receives its result. | `packages/shared/src/database/errors.ts`, `packages/appkit/src/plugin/plugin.ts:488-518`, `packages/appkit/src/plugin/interceptors/telemetry.ts` |
| Types | Database typegen loads the schema and writes `shared/appkit-types/database.d.ts`. Server and browser types use separate registry bindings. | `packages/appkit/src/type-generator/database/generate.ts`, `packages/appkit/src/type-generator/database/walk-schema.ts` |
| Packaging | The server preset builds the server entry and agent entries with `unbundle: true`. It has no database-operation discovery. | `packages/appkit/src/tsdown/index.ts:43-81` |
| Browser | The client resolves URLs from registered endpoints and raises `NOT_EXPOSED` without a request for a missing entry. | `packages/appkit-ui/src/js/database/client.ts:175-198` |

The playground currently limits writes to `boards` and `notes`, but that setting still leaves reads on `note_events`
(`apps/dev-playground/server/index.ts:74-81`). A policy on a new route would not protect the generated route beside it.

Public PR [#682](https://github.com/databricks/appkit/pull/682) is an unmerged operations-first POC with
`defineQuery`, `defineMutation`, and `definePolicy`. This proposal uses it as prior art, not as the baseline. It closes
legacy exposure, adds schema-derived contracts and client types, and specifies production packaging.
Design [001](https://github.com/databricks/appkit/pull/677) separately addresses database development and migrations.
This proposal preserves its service-principal execution model.

## Goals

1. The database plugin registers only explicitly authored operations with authorization. Custom Express routes remain
   the application author's responsibility.
2. Authentication precedes policy lookup and execution. Authorization always precedes `execute`.
3. Column metadata supplies types, defaults, and validation without a duplicate Zod schema for ordinary writes.
4. Reuse the schema's public and writable field metadata instead of requiring a second field list per operation.
5. Source development and a source-less production build use the same selected operation modules.
6. Custom operations have typed browser calls and generic React hooks without importing server code.
7. Turning operations off never restores generated CRUD.

## Out of scope

- RLS and per-user database credentials. The application server enforces authorization.
- A framework-wide authorization DSL, role store, policy combinators, or migration of every plugin's policy API.
- A server-code sandbox, a new read-only fluent database API, or an automatic locking abstraction.
- Custom URL patterns, uploads, streaming, batch operations, and automatic idempotency.
- Operation result caches and automatic retries.
- Automatic user-scoped data access or forwarding a user token into an operation context. Resolving caller identity
  during authentication does not change the database credential.

## Product decisions

### No implicit or legacy database HTTP routes

Remove generated table CRUD and the `api` field. There is no migration guard, compatibility flag, or deprecated alias.
`database({ routes: databaseRoutes })` exposes operations. Absent `routes`, or `routes: false`, exposes nothing.
An untyped old option cannot enable a route because the old registration loop is removed.
Trusted `appkit.database` access and explicit transactions remain. Entity lifecycle hooks and `serialize` are removed.
The operator approved this removal and accepted breaking changes without a compatibility layer.

The operator accepted removal without compatibility work and requires first-party database apps to adopt the new
operation routes. The app cutover and deletion of their generated CRUD paths happen together, not through a permanent
compatibility router. No configuration of the removed API can restore an unauthenticated alternate.

### Required authorization has runtime enforcement too

TypeScript requires `authorize`. For untyped declarations, a missing or invalid `authorize` skips the operation.
Boot logs its file and export name. It never supplies an allow-all default. Recommend making this condition fatal in
production builds and CI while preserving the required skip-and-warn behavior at runtime.

### Infer ordinary contracts and make overrides optional

The operator confirmed that the table and method infer CRUD input and output. GET takes the public key. POST takes
the create body with schema-derived required fields, optional fields, and defaults. PATCH takes the key and changes.
No `input`, `output`, field list, or `name` is required for those operations.

An explicit Zod `input` overrides the conventional request contract. An explicit Zod `output` describes and validates
a non-default response. `execute` owns response mapping. A non-row response needs that output override unless a
future generator can prove its client type by inspecting the executor. V1 makes no such arbitrary-return claim.

The schema's HTTP capabilities exclude private, generated, and non-updatable fields. They are not authorization.
Adding a public column can expand inferred contracts. App authors must mark server-owned data appropriately and use
an optional narrower input when an operation should accept only a subset, such as a title-only rename.

### Keep one explicit place for business behavior

Remove `beforeCreate`, `afterCreate`, `beforeUpdate`, `afterUpdate`, `beforeUpsert`, `afterUpsert`, `beforeDelete`,
`afterDelete`, and `serialize`, including their public types and serializer-only client overrides. Keep React data
hooks, wire encoding, and private-column projection. They have independent responsibilities.

Operation-specific behavior belongs in `execute`. Shared behavior belongs in an ordinary domain function called by
operations and trusted server callers. Writes and audit records that need atomicity use `db.transaction` explicitly.
There is no replacement lifecycle framework or automatic transaction around every executor.

This removal is approved. A direct entity write no longer invokes normalization or audit callbacks. Removed fields
simply disappear from the type and implementation. There is no special runtime handling of a leftover `hooks` key.

The empty events panel in the subtraction slice is not the final app migration. The playground's new note-creation
operation must explicitly create the note and its `note_events` row in one transaction. Migrate every first-party
app that uses database to the operation API. Do not recreate hooks or add a one-off endpoint outside that API.

### Conceal resource denials by default

An absent actor gets 401. A resource policy's missing resource, denial, malformed result, or exception gets the same
opaque 404. A policy without a resource lookup denies with 403. An explicit fixed denial can choose 403 or 404.
No denial includes a caller-supplied error message. The concealment default awaits validation.

## Architecture decisions

### One registry owns registration

The organizing data shape is an immutable `OperationRegistry`, indexed by operation id and canonical method plus
URL. The exact public id and URL format remains open. Each entry binds its schema-derived contract, authorization,
executor, and diagnostic source location.
`Policy` separates the actor, validated input, and optional resource snapshot. There is one authorization evaluator.

The explicit `name` property is removed. One candidate is to derive `<entity>.<exportName>`, so `export const
renameTask` for `tasks` would become `tasks.renameTask` at `/api/database/operations/tasks.renameTask`. Under that
candidate, moving files would preserve identity while renaming the export or entity would change the API. The operator
has not confirmed this public format. Examples below illustrate the candidate, not an approved routing contract.

Validate and bound identifiers, compare canonical routes with Express-equivalent case and slash semantics, and reject
duplicate ids or aliases of the same descriptor before anything mounts. No entity-based CRUD aliases remain.

Rejected alternatives:

- A policy map on generated CRUD needs a separate mechanism for custom actions and can preserve implicit exposure.
- Separate `defineQuery` and `defineMutation` builders duplicate the method distinction without solving inference.
- A mandatory explicit `name` repeats identity already present in the export. The operator requested its removal.
  No replacement public-id format or stable-alias configuration is approved yet.
- An `action` field duplicates the conventional method mapping. A custom action supplies an optional input override.
- A legacy `api` flag violates the off-state guarantee.

### Table and method infer the default request and response

| Method without overrides | Validated input | Default output |
|---|---|---|
| GET | `{ id }` using the public key's canonical value type | One public row, or 404 |
| POST | The HTTP create body, preserving required fields, optionality, and defaults | The created public row |
| PATCH | `{ id, changes }` with a non-empty HTTP update payload | The updated public row, or 404 |
| PUT | `{ id, values }` for a full public replacement payload | The resulting public row, or 404 |
| DELETE | `{ id }` | 204 on true, or 404 on false |

These contracts use the schema's HTTP facets, not the trusted validators that admit private fields. Entities without
an addressable public key need an explicit input for methods that otherwise require one. List and summary operations
are custom GETs with an input override and a non-row output override. Their export names do not change inference.
PUT replacement and schema-default semantics must be pinned in the contract prototype before implementation.

Wire input and callback input differ. Reuse the existing codecs in
`packages/appkit/src/plugins/database/crud/codecs.ts` and the `WireInput` and `WireOutput` adapters in
`packages/shared/src/database/api-types.ts`. Bigint inputs are decimal strings or safe integers on the wire and
`bigint` after decoding. Bigint outputs are decimal strings. The browser never stringifies native bigint.

Optional Zod input replaces the conventional contract. Object inputs must be strict, including nested contracts.
Unknown fields are rejected. V1 supports JSON-renderable structural schemas and representable input defaults.
Transforms, preprocessors, coercion, `any`, `unknown`, and unsupported constructs fail generation.

### Output is an optional contract, not a serializer callback

Without `output`, runtime rebuilds the conventional response through the table's public projection and codecs. It
never forwards the trusted row object directly. Existing safe HTTP encoding remains after callback removal.

With `output`, the executor maps to the custom value and the runtime validates that value against the supplied Zod
schema. V1 requires JSON-value output with strict objects and no transforms, coercion, defaults, or catches. Client
types derive from that schema. Invalid executor output is opaque 500. Importing server modules or emitting `unknown`
is not a fallback for an unsupported custom schema.

Output validation after commit does not undo a write. If a malformed result must roll back, map and validate it inside
the explicit transaction. SQL rollback never undoes an LLM request, email, or other external side effect.

### Callbacks and reusable policies share one evaluator

`authorize` accepts an async callback or `definePolicy({ resource?, allow })`. An inline callback normalizes to a
no-resource policy. It receives `resource: undefined`. A resource policy runs its lookup once after authentication
and parsing, skips `allow` on null, and passes the same non-null resource to `allow` and `execute`.

Only literal `true` grants. `false`, malformed values, rejected promises, and thrown exceptions deny. A policy can
return `{ deny: "forbidden" }` or `{ deny: "not-found" }`. Internal diagnostics use fixed reasons, not arbitrary
client-facing text.

The resource is a snapshot, not a lock. A state-dependent mutation must repeat its complete authorization predicate
in a conditional write or re-read and lock the relevant rows in a transaction. A transaction at the default isolation
level does not automatically make an earlier lookup authoritative.

Policy descriptors expose readonly `resource` and `allow` functions. Application tests can call them with explicit
actor and database fixtures without enabling an HTTP actor override. The dispatcher and actor injection seam remain
internal. Supporting direct policy tests does not add a network bypass.

The Files plugin already has async boolean policies and `FilePolicyUser.id`
(`packages/appkit/src/plugins/files/policy.ts`). Use the same `actor.id` spelling. Database policies additionally need
validated operation input, resource loading, and concealed denials. Reuse those concepts, not Files' SP fallback or
its action and volume-specific combinators. Unifying both APIs is outside this change.

### Actor identity is not a database credential

`Actor` contains an authenticated end user's canonical workspace SCIM `id` and optional email. Email is not an
ownership key. The registry's dispatcher never turns an actor into `CallerContext`, never chooses an OBO pool, and
rejects an inherited caller scope rather than silently elevating it to app execution.

Context contains the ordinary service AppKit handle and `db`, an alias for `appkit.database`. It contains neither the
request nor a user token. Trusted server code can still close over other handles or deliberately call OBO APIs for
other resources. This is not a sandbox or a claim that such calls are impossible. The database credential remains the
service principal, and its app-only guard stays in force.

Recommended v1 actor integrations:

- On Apps, do not assume `X-Forwarded-User` is a SCIM id. The public header contract describes an IdP identifier.
  A supported canonical path is to validate the request's forwarded user credential through the workspace Current
  User `Me` API, using identity-read scopes, and use the returned id. This authenticates the caller; database queries
  still use the service principal. It does not open `CallerContext`. Missing or invalid request credentials deny
  before lookup or execution. The verified resolver and actual Apps integration still require implementation proof.
  Header presence and deployment environment variables alone never establish an actor.
- In explicit local development, resolve the signed-in developer through the existing local identity loader in
  `packages/shared/src/dev-obo.ts`. Copy only `id` and email into the actor, never its token. Check the socket,
  host, origin, and fetch metadata on every operation request, even if forwarded headers exist. Extract the existing
  loopback predicate from `packages/appkit/src/plugins/server/dev-obo-middleware.ts`, not its header short-circuit.
  Follow its explicit credential and `APPKIT_DEV_OBO` enable rules. Missing credentials gives 401. Forwarded headers
  never choose the local actor. A local process or tunnel with loopback access is within the developer's trust
  boundary, so this mode must not be exposed through forwarding or remote tunnels.

A recognized Apps boundary takes precedence over development mode. There is no `dev-user` or service-principal actor.
Canonical identity must come from the same authority in Apps and local development. The public sources are
[Apps authorization](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/auth),
[forwarded headers](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/http-headers), and
[Current User Me](https://docs.databricks.com/api/workspace/currentuser/me). Forwarding a user credential for identity
validation is not OBO database execution. Support for other hosting remains an explicit scope question.

### Generate one server-only static registry

Discovery occurs in `appkit generate-types`, not in plain Node at startup. It scans `server/database/routes/*.ts`
in deterministic order, imports each module for contract inspection, and writes a committed server registry.
Named tagged declarations are inspected. Ordinary helper exports are ignored, and a tagged default export is rejected.
Modules must be safe to import without a running app.

```ts
// server/database/routes.gen.ts, generated
import { schema } from "../../config/database/schema";
import * as tasks from "./routes/tasks";

export const databaseRoutes = {
	schema,
	files: { "server/database/routes/tasks.ts": tasks },
} as const;
```

The app statically imports `databaseRoutes` and passes it to `database({ routes: databaseRoutes })`. The registry
imports the schema too, so the intended production graph does not depend on source files or runtime Jiti.
`routes.schema` supplies the plugin schema. A distinct explicit `schema` is an error.

Generation alone writes the registry and client declarations. Setup is read-only and runs the same descriptor
validator. Import namespaces deliberately retain tagged invalid declarations so boot can name and warn about a missing
`authorize`, even when typegen already omitted that operation from client types. Only valid entries reach endpoints.
The generated file shows the eligible modules. The operation source and generated declaration show callable exports.

Use existing atomic file replacement, not a new manifest store, lease, or generation-pointer protocol. CI and
production `prebuild` run proposed `appkit generate-types --wait --strict --check`. Check mode verifies committed
artifacts without replacing them. Drift, invalid authorization, or generation errors fail the build. Development
writes current artifacts and warns for skipped authorization. A broken generation clears client operation types and
must not publish a candidate dispatcher.

In dev, the watcher observes schema, routes, additions, removals, and imported dependencies. It stops dispatch before
rebuilding or restarting. It resumes only after the current registry validates. A failed generation cannot keep an
old authorized operation serving. Existing Vite watching and `tsx watch` are starting points, not proof that this
lifecycle already works. There is no production hot reload.

A static import graph, schema inclusion, exact emitted paths, and guarded startup diagnostics need a source-less
bundle proof. Static import failures can occur before plugin setup. Do not assume the current dynamic schema loader
sanitizes those Node startup errors. The production bootstrap must report a bounded startup failure without printing
module-thrown secrets before the privacy contract is accepted.

Rejected alternatives are runtime TS scanning, a manual module list, a second `routes: true` mode, and a registry
under the client's `shared/appkit-types` directory. The explicit generated import is the only opt-in.

### Authentication and error handling own the HTTP boundary

A namespace adapter covers `/api/database/operations` before the global body parser and frontend fallback. It
resolves the actor before decoding or dispatch, including unknown operation names and wrong methods. Unauthenticated
calls get 401. Authenticated calls to an unknown name or method get opaque 404.

The current `skipBodyParsing` set matches exact strings, while Express normally accepts case and trailing-slash
variants (`packages/appkit/src/plugins/server/index.ts:144-153`). It is insufficient by itself. The server integration
must exclude the operation namespace with matching semantics, then apply its bounded parser after authentication.
Use the configured body limit. Tests cover canonical, mixed-case, trailing-slash, and unknown routes. Other plugin
namespaces keep their behavior.

GET carries one bounded JSON `input` query value. Reject repeated values, unexpected query parameters, invalid JSON,
and oversized input through one operation decoder. Other methods use bounded JSON bodies and require
`application/json`. GET executors must be side-effect-free by API contract. The library cannot prove arbitrary
callback purity. Sensitive input belongs in a non-GET operation because URLs also reach browser and proxy logs.

Cookie-backed mutations require a verified same-origin or equivalent CSRF boundary. JSON content type alone is not
that proof. Use a trusted deployment origin, not unverified forwarded headers. Missing platform confirmation blocks
release of the integration.

All operation failures end in the operation response adapter. They are not forwarded as raw exceptions to generic
Express error handling. Unknown properties and invalid contracts yield value-free validation details.

### Interceptors cannot bypass authorization

The sequence is actor, parse, resource, allow, execute, output. Authorization stays outside `Plugin.execute`.
The executor wrapper forces cache and retry off and enables telemetry. It has no generic timeout or user override.
Entity operations continue using their existing execution defaults and explicit transaction context. No mutation
hook or serializer is invoked.

Crucially, the callback passed into `Plugin.execute` catches and classifies errors before that plugin's logger and
telemetry interceptor observe them. Preserve a known `DatabasePluginError` category. Convert other executor errors
to a safe operation error without the original message, cause, or row data. Retain only bounded diagnostics outside
the exception. Mapping the returned status and discarding its message afterward would be too late.

A lookup or `allow` exception always denies, including a classified database outage. This is the operator's
fail-closed rule. The internal stage distinguishes an outage from a deliberate denial without changing the response.
An executor's database error keeps its normal category.

The database's statement and transaction limits are not an end-to-end request deadline. A callback awaiting non-SQL
I/O can still hang in v1 and must supply its own dependency deadline. No JavaScript timeout, client disconnect, or
AbortSignal is claimed to cancel SQL. Automatic retries could repeat committed mutations and remain disabled.

### Flag strategy

`routes?: DatabaseRoutes | false` is the only behavior switch. Its default is off. An empty validated registry also
serves nothing. Turning it off removes operations at the next start, publishes no endpoints, and never enables CRUD.
Types, policy helpers, code generation, and unreachable internals need no feature flag. The first user-reachable
slice must introduce this switch together with authorization enforcement. Strict generation is a build check, not a
second runtime exposure flag. Actor-integration selection is an authentication boundary, not an enable flag.

## Main design

### What an app author writes

Assume a schema entity `tasks` with numeric `id`, `title`, `done`, and private server-controlled `owner_id`. These
are proposed examples, not the current playground schema.

```ts
// server/database/policies.ts
import { definePolicy, type PolicyContext } from "@databricks/appkit/beta";

export const authenticated = definePolicy({ allow: () => true });

export const ownerOnly = definePolicy({
	resource: ({ actor, db, input }: PolicyContext<{ id: number }>) =>
		db.tasks.where({ owner_id: actor.id }).find(input.id),
	allow: () => true,
});
```

```ts
// server/database/routes/tasks.ts
import { defineOperation } from "@databricks/appkit/beta";
import { z } from "zod";
import { authenticated, ownerOnly } from "../policies";

export const createTask = defineOperation({
	entity: "tasks",
	method: "POST",
	authorize: authenticated,
	execute: ({ actor, db, input }) => db.tasks.create({ ...input, owner_id: actor.id }),
});

export const renameTask = defineOperation({
	entity: "tasks",
	method: "PATCH",
	authorize: ownerOnly,
	execute: ({ actor, db, input, resource }) =>
		db.tasks.where({ owner_id: actor.id }).update(resource.id, input.changes),
});

export const listTasks = defineOperation({
	entity: "tasks",
	method: "GET",
	input: z.strictObject({ limit: z.number().int().min(1).max(100).default(20) }),
	output: z.array(z.strictObject({ id: z.number(), title: z.string() })),
	authorize: authenticated,
	execute: async ({ actor, db, input }) => {
		const rows = await db.tasks.where({ owner_id: actor.id }).limit(input.limit).toArray();
		return rows.map(({ id, title }) => ({ id, title }));
	},
});
```

`ownerOnly` can serve any compatible input containing `id`, including a custom action with an explicit Zod schema.
Its lookup already filters by the actor's owner id. Only a non-null owned row reaches `allow`. The owner condition is
repeated in the mutation. If ownership changes after the lookup, a null result becomes 404.
A policy checking additional mutable state must also protect that state at write time. `renameTask` accepts the
schema's ordinary update fields, not only `title`. A title-only contract would supply an optional narrower input.

```ts
// server/server.ts
import { database } from "@databricks/appkit/beta";
import { databaseRoutes } from "./database/routes.gen";

const registration = database({ routes: databaseRoutes });
```

The existing app passes this registration to `createApp`. One file can export several operations. The folder and
registry do not register helpers or automatically create an operation per table.

### API changes

The intended signature sketch is not compiler-verified. Registry-derived helper types follow the input and output
tables above. Inference, variance, and contextual typing are proof obligations, not established behavior.

```ts
type Awaitable<T> = T | Promise<T>;
type Actor = Readonly<{ id: string; email?: string }>;
type Decision = boolean | { readonly deny: "forbidden" | "not-found" };
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

type PolicyContext<I> = Readonly<{
	actor: Actor;
	input: I;
	appkit: AppKitHandle;
	db: DatabaseExports;
}>;
type OperationContext<I, R> = PolicyContext<I> & { readonly resource: R };

declare function definePolicy<I, R>(spec: {
	resource(ctx: PolicyContext<I>): Awaitable<R | null | undefined>;
	allow(ctx: OperationContext<I, NonNullable<R>>): Awaitable<Decision>;
}): ResourcePolicy<I, NonNullable<R>>;
declare function definePolicy<I = unknown>(spec: {
	allow(ctx: OperationContext<I, undefined>): Awaitable<Decision>;
}): PlainPolicy<I>;

declare function defineOperation<
	const E extends EntityName,
	const M extends HttpMethod,
	I extends ZodType | undefined = undefined,
	O extends ZodType | undefined = undefined,
	R = undefined,
>(spec: {
	readonly entity: E;
	readonly method: M;
	readonly input?: I;
	readonly output?: O;
	readonly authorize: Policy<InputOf<E, M, I>, R> | InlineAuthorize<InputOf<E, M, I>>;
	execute(ctx: OperationContext<InputOf<E, M, I>, R>): Awaitable<ResultOf<E, M, O>>;
}): Operation<E, M, I, O>;
```

An inline callback has no resource. A resource policy supplies its inferred non-null resource. The final overloads
must enforce that distinction. `InputOf` and `ResultOf` choose the method/table default when no override exists and
the Zod contract otherwise. Discovery supplies export identity after definition. `entity` is a generated schema key.
With custom contracts it is the primary entity label, not a claim that execution touches only that table.

`defineOperation` brands a descriptor without throwing for missing authorization. Otherwise import would abort
before discovery could report the ignored export. Shared validation runs during generation and setup. Other malformed
contracts fail the candidate registry instead of receiving defaults.

Add server helpers and types to `@databricks/appkit/beta`, add `routes?: DatabaseRoutes | false`, and add
`UNAUTHENTICATED` to the shared database error vocabulary. Determine the typed AppKit handle available through plugin
context before implementing the public context. No `appkit.db` API is introduced. Remove `hooks`, its lifecycle and
serializer types, `serialized<T>()`, and serializer-only `shape` options. Do not add compatibility checks or migration
warnings for removed options. Existing structural config validation remains independent of this removal.

### Request outcomes

| Condition | HTTP result | May execute? |
|---|---|---|
| Missing or unverified actor under a supported integration | 401 `UNAUTHENTICATED` | No |
| Authenticated unknown operation or wrong method | 404 `NOT_FOUND` | No |
| Bad encoding, oversized input, or wrong content type | 400, 413, or 415 | No |
| Schema failure, extra field, or empty update | 422 `VALIDATION_FAILED` | No |
| Resource missing, or lookup throws | Opaque 404 | No |
| Resource policy denies, throws, or returns a malformed decision | Opaque 404 by default | No |
| No-resource authorization denies or throws | 403 `FORBIDDEN` by default | No |
| Explicit fixed deny | 403 or 404 | No |
| Conventional POST succeeds | 201 with the public created row | Once |
| Conventional DELETE succeeds | 204 without a body | Once |
| Other allowed callback succeeds | 200 with its inferred or custom response | Once |
| Conventional row output receives null | 404 `NOT_FOUND` | Already ran |
| Executor throws a known database error | Its safe database category | Already ran |
| Other executor error or invalid output | 500 `INTERNAL` | Already ran |

Every response uses `Cache-Control: no-store`. Reusing `FORBIDDEN` covers both a policy denial and database privilege
failure, but stage and reason distinguish them internally. No raw error text reaches the response adapter.

### Boot and reload outcomes

| Condition | Required behavior |
|---|---|
| `routes` absent or false | Zero database endpoints. Trusted server API remains. |
| Untyped removed `api` option present | It cannot enable anything. The old route registration path does not exist. |
| Source routes folder missing or empty | Generation produces an explicit empty registry. |
| Tagged operation has missing or invalid authorization | Retain diagnostic declaration, skip HTTP registration, warn with `file#export`. Strict generation fails. |
| Ordinary helper export | Ignore. |
| Bad contract, unknown entity, duplicate, or import failure | Fail generation or setup. Publish no candidate router. |
| Expected generated registry or compiled module missing | Fail build or boot. Never reinterpret it as an empty source folder. |
| Failure after opening a pool | Close the candidate pool and publish nothing. |
| Dev rebuild fails or authorization is removed | Disable dispatch before rebuild. No last-good serving registry. |
| Production source changes on disk | No hot reload. Serving state changes only through a new validated start. |

Boot can log, for example, `server/database/routes/tasks.ts#purgeTasks skipped: authorize is missing`.
`createApp` already awaits setup before listening (`packages/appkit/src/core/appkit.ts:304-327`). That ordering does
not prove the proposed watcher or build integration.

### Generate browser types without server imports

Derive the browser contract from the same inspected exports, entity/method defaults, and optional Zod overrides. Emit a
global operation registry in `shared/appkit-types/database.d.ts`, analogous to the current entity bridge. It contains
wire input, serialized output, and method per operation. No declaration imports a route, server schema, or policy.

Default types use existing column metadata and wire adapters. Custom schemas use Zod's JSON Schema conversion
plus a bounded TypeScript renderer. Unsupported constructs fail generation. Do not emit `unknown` or infer arbitrary
executor return types as a fallback.

Boot metadata publishes only registered names, methods, and URLs. The existing endpoint map stores paths, so method
metadata is new. It never publishes policies, schema internals, tokens, private fields, or the server registry.

Proposed browser calls are:

```ts
const tasks = await databaseApi.call("tasks.listTasks", { limit: 20 });
const renamed = await databaseApi.call("tasks.renameTask", { id: 42, changes: { title: "Reviewed" } });
```

`useDatabaseQuery(name, input)` accepts GET names. `useDatabaseMutation(name)` accepts non-GET names. These generic
hooks replace the CRUD hooks and reuse cancellation and mutation lifecycle code where its guarantees fit. No hook is
generated per operation. A missing endpoint raises `NOT_EXPOSED` without a request.

V1 does not share results or pending requests across hooks. On a session transition, clear operation state and reject
late results from the previous session. A supported session-change signal is an integration proof obligation, not an
assumption that an in-page identity never changes. Successful mutations invalidate active queries broadly instead of
introducing a dependency DSL. Mutations never automatically retry. A lost response reports proposed
`OUTCOME_UNKNOWN`, not permission to resend.

## Observability

One `database.operation` span covers actor resolution through output handling, including denials. It records
operation, entity, method, canonical route, stage, outcome, and a fixed denial reason. Logs use those fields and a
trace id. Skips log file and export at warn. Exceptions log bounded class or category information, not their message,
cause, actor, email, input, or resource.

This requires more than an allowlist on the custom span:

- Sanitize executor failures inside the execution callback before `Plugin.execute` and `TelemetryInterceptor` log or
  record them. A sentinel-secret test must inspect actual exported logs and spans.
- Redact query-bearing `url.query`, `http.target`, `http.url`, and equivalent HTTP attributes for operation traffic.
  Renaming the span does not remove attributes. The current HTTP instrumentation changes names only
  (`packages/appkit/src/telemetry/instrumentations.ts`).
- Prevent Lakebase SQL text and raw driver exception details from leaking operation data. The current connector
  records SQL and exceptions (`packages/lakebase/src/pool.ts:87-117`). Operation-path redaction is a release gate.
- Bound startup diagnostics for import failures before claiming sanitized boot errors.

Do not claim repository-wide telemetry is already sanitized. Other plugins and external proxy logs need their own
contracts. GET URLs must contain no secrets even after AppKit's own trace redaction.

## Security considerations

The browser, its input, and any client-sent identity fields are untrusted. The server author, policy code, and
executor are trusted and have the service principal's database privilege. Required authorization prevents omission,
not a logically incorrect policy. RLS is explicitly excluded, so PostgreSQL supplies no per-user safety net.

| Threat | Enforcement or limitation |
|---|---|
| Omitted policy or forgotten route restriction | Required `authorize`, runtime skip, strict build, and no generated CRUD. |
| Spoofed actor | Verified deployment integration, no header-presence inference, no local synthetic actor. |
| Another user's row | Resource policy and conditional writes. List executors must also constrain their rows. |
| New public owner or role field | HTTP schema metadata excludes private and generated fields. Public writable additions widen defaults and require schema review or a narrower override. |
| Private response field | Runtime public projection or strict custom output. Public columns widen default responses. An author can still copy a secret into a declared custom field. |
| Cache bypass or cross-user reuse | Authorization outside interceptors, no server cache, no cross-hook sharing, session-bound client state. |
| Duplicate mutation | No automatic client or server retry. Repeated user submission still needs application idempotency. |
| Ownership or state changes after lookup | Resource is a snapshot. Protect the complete predicate in the write or transaction. |
| Authorization outage | Lookup and policy exceptions deny. Logs distinguish the failure without revealing it to callers. |
| Stale dev authorization | Dispatch stops before rebuild and restarts only with a valid current registry. |
| CSRF or GET mutation | Verified mutation origin boundary and side-effect-free GET contract. JSON alone is insufficient. |
| Expensive or hung callbacks | Bounded transport and SQL limits. Non-SQL dependency deadlines remain the author's responsibility in v1. |
| Server secrets in the browser | Server-only registry and structural declarations. Add a client import restriction and inspect the actual bundle. |
| Unprotected custom Express routes | Outside the database plugin's guarantee. Trusted server code can bypass these building blocks. |

## Platform dependencies

| Ask | Why |
|---|---|
| Confirm stripping and injection of Apps user headers, including SP-only deployments, and name the supported deployment boundary. | Client-supplied headers or environment presence cannot establish the actor. |
| Verify the forwarded user credential and identity-read scopes needed for workspace `Me`, or provide an equally verified canonical identity adapter. | IdP header strings are not documented as SCIM ids. Ownership needs the same authority in dev and production. |
| Confirm the trusted external origin, cookie and CSRF protections, and session transition signal. | Mutation authentication and browser state must remain bound to the current user. |

These are engineering release prerequisites for the Apps integration. They are not facts established by this repo and
not product preferences for the operator to guess.

## Rollout plan

1. Apply the approved subtraction first. Remove hooks, `serialize`, serializer-only client helpers, and their demo
   wiring in an independent slice. Preserve explicit transactions, ordinary CRUD contracts, and HTTP protections.
   The operator accepted breaking changes and requires no compatibility layer. Other operation behavior still waits
   for validation of the remaining design questions.
2. Run the type, Zod, packaging, identity, transport, and reload proofs below. Record artifacts and revise the design
   if a proof fails. Do not silently replace a missing proof with a type assertion or fallback router.
3. After validation, plan independently verifiable slices. Types and unreachable internals need no behavior flag.
   The first reachable operation path must have the explicit registry opt-in and no unprotected legacy alternate.
4. Migrate repository callers, docs, template, playground, and browser APIs to the current operation model. Preserve
   the playground's note-plus-event behavior through an explicit executor transaction. Do not add legacy adapters or
   migration-only handling. Never release an intermediate version that reopens CRUD when operations are off.
5. Release only after the negative behavior matrix, source-less bundle, real Apps identity, and telemetry privacy
   gates pass. Production rollout is a separate approved plan.

Required implementation evidence includes:

| Area | Later proof |
|---|---|
| Authentication | Missing identity, forged headers, dev disable rules, unsupported hosting, and malformed body all fail before lookup or execute. |
| Authorization | False, malformed return, null lookup, thrown lookup, thrown allow, async allow, explicit deny, and reused resource all have the specified status and execute count. |
| Defaults | Missing policy is absent from routes and warns at boot. Strict CI fails. Neither flag state can enable legacy CRUD. |
| Inference | Method/table defaults without required name/input/output, discovery ids after format validation, incompatible policy input, non-null resource, bigint keys and writes, strict overrides, and unsupported Zod schemas. |
| Output | Default public projection excludes private columns. Explicit custom contracts reject undeclared fields. Invalid custom output is opaque 500. |
| Subtraction | Hooks, serializer exports, and removed fields are gone without compatibility guards. Explicit transaction commit/rollback/join/expiry/isolation and deadline remain covered. |
| Interceptors | Denials never enter execute, a transient mutation runs once, and no actor receives another actor's cached result. |
| Transport | Case and slash variants, unknown names and methods, repeated query values, limits, content type, and CSRF boundary. |
| Discovery | Add, remove, remove authorization, import error, duplicate, stale artifact, failed restart, and generated-file drift. |
| Production | Plain Node serves compiled operations with `server/` and `config/` source trees absent. Inspect client and server bundles. |
| Client | Missing endpoint sends nothing. Session switch rejects old pending results. Lost mutation response never retries. |
| Privacy | Sentinel input, row values, and exception messages do not reach exported operation, HTTP, execution, or Lakebase telemetry. |
| Integration | Dev playground exercises allowed and denied users through the actual HTTP path. Vitest assertions alone are not live identity proof. |

After implementation changes, run `pnpm build && pnpm docs:build` and
`pnpm check:fix && pnpm -r typecheck`, alongside the relevant Vitest and integration checks. None ran for this design.

## PR stack

1. `00-design`. This document only. Its draft pull request is the review entry point.
2. `01-remove-hooks`. Approved removal of entity hooks, `serialize`, serializer-only client APIs, and their callers.
   This does not introduce or enable operation routes.
3. `02-operation-definitions`. Typed descriptors, inferred method/table contracts, reusable policy definitions, and
   real package-consumer compile probes. No loader, actor resolver, or HTTP registration.
4. Operation execution, discovery, client generation, and the app cutover follow as independently verified slices.
   The final cutover migrates every first-party database app and removes its old route path.

The exact public routing format remains open. Defining metadata and types does not settle or expose that format.

## Open questions

The settled requirements are mandatory authorization, skip-and-warn for missing authorization at boot, 401 for an
unauthenticated caller, no execute after a lookup or authorization exception, and no RLS. The operator also confirmed
removal of explicit `name`, inferred CRUD input/output with optional overrides, and removal of hooks and `serialize`.
Breaking changes and removal without compatibility shims are accepted. The operator explicitly rejected special
runtime handling of removed fields and requires apps to move to the new routes, not stay as an empty demo.

### Product decisions for validation

1. Use concealed 404 for resource-policy denials and 403 otherwise, with fixed explicit overrides? Recommend yes.
   Required reviewers are AppKit maintainers and security.
2. Make strict, non-mutating generated-artifact verification mandatory in production builds and CI? Recommend yes,
   while runtime retains the required skip-and-warn behavior. Required reviewers are AppKit maintainers.
3. Limit v1 actor integrations to verified Apps and explicit local development, failing setup elsewhere? Recommend
   yes initially, without claiming other hosting is impossible. Required reviewers are AppKit and Apps maintainers.
   A concrete additional deployment can justify a verified adapter later.
4. What exact public operation id and URL should replace the explicit `name`? The export-derived candidate is not
   confirmed. Required reviewers are the operator and AppKit maintainers. This choice does not block hook removal.

### Engineering proof obligations

Local throwaway compiler experiments support one generic method-indexed signature for GET, POST, PATCH, and DELETE,
optional Zod overrides, and an annotated reusable resource policy. Unsuppressed negative controls reject missing
`authorize`, private default input, and incompatible policy inputs. These experiments used narrow contract mappings,
not the published package entry, so package-consumer proof is still required. One overload experiment was inconclusive.

Do not copy the experiments' gaps into the API. Separate nullable executor results from successful wire rows, map
bigint on the wire, and use an empty DELETE response rather than its internal boolean. Keep resource and `allow`
types correlated; do not accept an unrelated callback through a `never` parameter. A standalone reusable lookup may
need one input-context annotation. Runtime projection is required even when the type names only public columns.

Before release, prove Zod wire rendering, source-less imports, the actual AppKit context, pre-parser ordering,
fail-closed watching, canonical actor resolution, session behavior, and exported telemetry redaction. Those outcomes
are not established by type-checking a scratch model and are not operator preferences to guess.

The root `designs/` convention comes from open PR #677 rather than merged main. Recheck the design number in open PRs
before publication and merge.
