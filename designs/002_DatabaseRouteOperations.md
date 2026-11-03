# 002 - Database route operations

| | |
|---|---|
| **Status** | In review; implemented in the open operation stack |
| **Owner** | Victor Ditadi |
| **Design PR** | [#683](https://github.com/databricks/appkit/pull/683), first in the stack |

[Google Doc](https://docs.google.com/document/d/1zO0X7bCwYtmX6m-p7DFGZJneSa5OsgVd5nctGhCdVZY/edit)
is the linked comment copy. This repository document records the current implementation and supersedes its earlier
proposal for inferred CRUD inputs, export-derived names, and mandatory registry imports.

An app exposes database access to the browser through named, authorized operations. `database()` discovers operations
in the conventional directory; declaring tables alone exposes no HTTP endpoint. Inputs are explicit schemas or absent.
Outputs retain useful entity/method defaults, with explicit schemas for lists and custom responses. Browser calls and
React hooks are typed without importing server modules.

## Background and motivation

The earlier database beta generated table CRUD routes from schema declarations. Those routes used the app's service
principal and had no required per-operation user authorization. Adding a protected custom route beside them did not
protect the generated route. Lifecycle hooks also spread business behavior between table declarations and callers.

This design replaces that HTTP surface while preserving trusted `appkit.database` access, schema-derived server types,
private-column projection, wire codecs, and explicit transactions. The operations-first POC in
[#682](https://github.com/databricks/appkit/pull/682) is prior art, rather than the implementation baseline.

Design [001](https://github.com/databricks/appkit/pull/677) covers database branches, migrations, and deployment. Its
migration chain and this operation chain are separate. This stack checks that declared tables and columns exist at
startup; it does not create or migrate them. Integrating the migration flow is separate work before both ship together.

## Goals

1. Register only authored operations with authorization, with no alternate generated CRUD endpoint.
2. Verify the caller before parsing input, then authorize before executing database work.
3. Make no-parameter operations simple to declare and call, without an empty Zod object.
4. Keep useful row-output defaults while making list, aggregate, and custom responses explicit.
5. Use conventional discovery in development and compiled registries in production.
6. Generate browser contracts and provide generic React hooks with clear read, write, and session behavior.
7. Keep transactional business rules visible in application code.

## Out of scope

- RLS, per-user database credentials, and automatic user-scoped database queries.
- A framework-wide role store, authorization DSL, policy combinators, or a server-code sandbox.
- Custom URL patterns, uploads, streaming, batching, automatic idempotency, and shared operation caches.
- Automatic retries, an automatic transaction around every operation, or rollback of external side effects.
- A replacement lifecycle-hook or response-serializer framework.

## Product decisions

### Operations are the only database HTTP surface

Remove the legacy `api` option, AutoCRUD routes, entity-based browser CRUD calls and hooks, lifecycle hooks,
`serialize`, and serializer-only shape overrides. There is no compatibility router or alias. Disabling operations never
restores table CRUD. Trusted server entity clients, `sql`, and `transaction` remain.

Business behavior belongs in `execute` or an ordinary domain function shared with trusted server callers. Related
writes and audit records use an explicit transaction. Constraints that must hold for every writer belong in PostgreSQL.

### Conventional routes require no registry import

The three supported configurations are:

```ts
database(); // Discover the conventional generated registry.
database({ routes: false }); // Trusted server database access only.
database({ routes: customRoutes }); // Use an explicit registry for another layout.
```

The conventional source is `server/database/routes/*.ts`, through `server/database/routes.gen.ts`. The registry is
still generated and committed; app authors do not need to import it into the server entry. No operations means no HTTP
endpoint. Outside development, an existing routes directory without its registry fails setup with generation guidance.
Import failures and invalid registries never fall back to a different router.

### Public names are explicit and stable

Every operation requires `name`, such as `"notes.list"`, and answers its declared method at
`/api/database/operations/<encoded name>`. Moving a file or renaming its export does not change the public API.
Names contain dot-separated parts made of letters, digits, `_`, and `-`; each part starts with a letter and has at most
64 characters, with at most 255 characters in total. `constructor` and `prototype` are reserved names. Duplicate names
fail validation, including a duplicate whose declaration lacks authorization.

### No input schema means no parameters

An absent `input` gives callbacks `undefined` and generates a browser input type of `void`. It never infers an ID,
create body, or patch from the entity or method. An operation that needs parameters declares its Zod schema.

```tsx
useDatabaseQuery("alerts.queue");
useDatabaseQuery("alerts.get", { id: "123" });

const refresh = useDatabaseMutation("alerts.refresh");
await refresh.mutate();
```

No-parameter requests may omit input or send an empty object, which normalizes to `undefined`. Other input fails before
policy lookup. An explicit schema controls parsing, defaults, optional properties, and unknown-key handling according to
its Zod semantics. Every object is not implicitly made strict. Server-owned values, such as ownership, come from the
verified actor and domain logic rather than client input.

### Output defaults remain

| Method | Executor result without `output` | Successful response |
|---|---|---|
| `GET` | Public entity row or `null` | Row, 200; `null` gives 404 |
| `POST` | Created public entity row | Row, 201 |
| `PATCH` / `PUT` | Updated public entity row or `null` | Row, 200; `null` gives 404 |
| `DELETE` | Boolean | `true` gives 204 with no body; `false` gives 404 |

The default row projection excludes private columns and relations. Existing codecs encode bigint as decimal strings
and timestamps as RFC 3339 text. Adding a public column can widen a default response, so schema review still matters.
An explicit output schema provides a narrower or different response; `execute` owns the mapping into it.

Lists, aggregates, custom responses, and successful nullable responses declare `output`. The presence of `{ id }` in
input never determines whether the answer is one object or an array. A GET list with no input needs only its array
output schema. A nullable output can return `null` with 200; otherwise a null GET/PATCH/PUT result gives 404.

### Authorization is required at both boundaries

TypeScript requires `authorize`. If an otherwise valid untyped declaration omits it, runtime setup and normal generation
skip it and warn with `file#export`. Production generation fails instead. An invalid authorization value, malformed
contract, unknown entity, duplicate name, or module import failure blocks the registry. A missing policy is never an
allow-all default, and skipping a policy does not hide another malformed field.

## Author experience

The following examples assume declared `notes` and `note_events` tables, with a numeric note ID and string author/body
columns. Generate the table types before authoring operations.

```ts
// server/database/policies.ts
import { definePolicy, type PolicyContext } from "@databricks/appkit/beta";

export const signedIn = definePolicy({ allow: () => true });

export const noteAuthor = definePolicy({
  resource: ({ db, input }: PolicyContext<{ readonly id: number }>) =>
    db.notes.find(input.id),
  allow: ({ actor, resource }) => resource.author === actor.id,
});
```

```ts
// server/database/routes/notes.ts
import { defineOperation } from "@databricks/appkit/beta";
import { z } from "zod";

import { noteAuthor, signedIn } from "../policies";

export const listNotes = defineOperation({
  name: "notes.list",
  entity: "notes",
  method: "GET",
  output: z.array(z.object({ id: z.number(), body: z.string() })),
  authorize: signedIn,
  execute: ({ db }) => db.notes.select(["id", "body"]).limit(100).toArray(),
});

export const getNote = defineOperation({
  name: "notes.get",
  entity: "notes",
  method: "GET",
  input: z.object({ id: z.number().int() }),
  authorize: noteAuthor,
  execute: ({ resource }) => resource,
});

export const createNote = defineOperation({
  name: "notes.create",
  entity: "notes",
  method: "POST",
  input: z.object({ body: z.string().trim().min(1) }),
  authorize: signedIn,
  execute: ({ actor, db, input }) =>
    db.transaction(async (tx) => {
      const note = await tx.notes.create({ author: actor.id, body: input.body });
      await tx.note_events.create({ note_id: note.id, action: "created" });
      return note;
    }),
});
```

`name`, `entity`, `method`, `authorize`, and `execute` are required. `input` and `output` are optional, independently.
An operation descriptor does not execute a policy or database query during declaration or generation.

Callbacks receive the verified `actor: { id, email? }`, parsed `input`, service-principal `db`, and `appkit` exports.
`allow` and `execute` also receive the loaded `resource`, or `undefined` for a policy without a lookup. The callback
context contains no request, headers, or user token. At runtime `appkit` contains registered plugin exports; its static
operation type makes other SDK plugins optional because a route module cannot know the app's registration list.

A reusable resource policy annotates the input fields its lookup reads. Operations with those fields can reuse it;
incompatible input is a type error. `allow` and `execute` receive the lookup's non-null resource type. A literal in a
custom output may need `as const` in the returned object to prevent TypeScript from widening it to `string`.

## Authentication and authorization

### Actor identity and database credentials are distinct

The database pool always uses the app's service principal. PostgreSQL sees one role, so an operation's authorization
and row predicates enforce user access. Custom Express routes and trusted server writes are outside that guarantee.

The actor boundary is selected from deployment configuration, then verifies requests:

| Deployment | Identity source and behavior |
|---|---|
| Databricks Apps, `DATABRICKS_APP_NAME` set outside development | Verify `x-forwarded-access-token` with workspace Current User Me on each request. User/email headers are not trusted. Rejected credentials, inactive users, and service principals give 401; workspace identity-service failure can give 503. |
| Explicit local development | `NODE_ENV=development` plus `DATABRICKS_TOKEN` or `DATABRICKS_CONFIG_PROFILE` uses the verified local OBO identity loader. Requests must satisfy the loopback and origin boundary. `APPKIT_DEV_OBO=false` disables it. Forwarded identity headers are ignored. |
| Other hosting/configuration | Resolve no actor, answer 401, and warn during setup. |

`actor.id` is the workspace user ID. No synthetic local actor or service-principal fallback is supplied. Actor
resolution occurs before route lookup and input parsing, including unknown names and wrong methods inside the operation
namespace. The operation passes no user credential to database execution.

### Policy evaluation

A function policy or a policy's `allow` must return literal `true` to admit. A resource policy runs its lookup once,
then reuses the result in `allow` and `execute`.

| Result | HTTP behavior |
|---|---|
| No verified actor | 401; no policy or executor runs |
| Literal `true` | Execute once |
| `false`, malformed return, or exception without a resource policy | 403; no execute |
| Resource returns `null` or `undefined` | 404; neither `allow` nor execute runs |
| Resource lookup/allow fails or refuses | 404 by default; no execute |
| `{ deny: "forbidden" }` / `{ deny: "not-found" }` | Explicit fixed 403 / 404 |

A denial's optional `reason` is neither sent nor logged. Callers receive stable messages without resource values or
policy exception text. A resource is a snapshot, not a lock or a transaction.

### Mutable rules and transactions

Authorization establishes permission at the time of the check. An operation that depends on a case remaining open,
stock remaining available, or an ownership value remaining unchanged must enforce that predicate again inside its
write transaction, using a locked read, conditional write, or database constraint.

Use database-generated IDs instead of `count() + 1`. Use uniqueness constraints for invariants such as one open case
per alert, and database enforcement when all writers must honor a rule. Write the business change and its accurate audit
record in the same transaction. Do not reconstruct a prior value from a stale browser or policy snapshot.

Transactions retain their existing commit, rollback, nested-join, expiry, statement-budget, and isolation semantics.
There is no automatic executor transaction. A transaction cannot undo another plugin's write or arbitrary external
work, and its deadline does not cancel arbitrary JavaScript.

## Discovery, generation, and packaging

### One inspected registry supplies runtime and browser contracts

The generator scans direct `*.ts` children of `server/database/routes/`, excluding `*.test.ts`, `*.d.ts`, and
`*.gen.ts`. Tagged `defineOperation` exports are inspected; ordinary helper exports are ignored. Recursive discovery
and export-derived public names are not part of the contract.

The existing `appkit generate-types` command and AppKit Vite plugin produce:

| Artifact | Purpose |
|---|---|
| `server/database/routes.gen.ts` | Lazy schema/module imports for runtime discovery and server packaging |
| `shared/appkit-types/database-operations.d.ts` | Structural operation-name, method, JSON input, and JSON output registry for browser consumers |
| `shared/appkit-types/database.d.ts` | Existing trusted server entity-type bridge |

Commit generated artifacts. Browser declarations import no operation, schema, or policy module. Runtime boot metadata
publishes registered operation names, URLs, and methods, without policies or schema internals.

Explicit contracts use Zod 4 JSON Schema conversion and a bounded TypeScript renderer. JSON strings, numbers,
booleans, null, literals, enums, arrays, objects, string-key records, unions, and `z.unknown()` are supported, including
supported optional/default/nullable wrappers. `z.unknown()` intentionally generates `unknown`; it is not a fallback for
an unrenderable contract. Unsupported schemas such as dates, tuples, `z.json()`, transforms, and coercing or
preprocessing inputs fail generation with a source/slot diagnostic rather than silently widening the contract.
Optional object properties work; schemas that require top-level undefined without an exact JSON form do not.

Production generation is selected by `NODE_ENV=production` and rejects missing authorization. This uses the existing
generation/build commands; there are no new `--wait`, `--strict`, or `--check` command flags.

### Development

A schema-only app receives an empty registry and empty browser operation declarations before its first route. During
development, database setup refreshes the registry before importing it, so a newly added or deleted route does not start
from a stale module list. Native imports let the standard `tsx watch` process track the registry and its dependencies.

The Vite generator watches `config/database/` and all of `server/database/`, including shared policies and DTOs.
Operation, schema, and shared-contract edits refresh browser types and reload the backend through the standard
workflow. First-route addition and last-route deletion use the same flow. Generated outputs are ignored as generation
triggers to prevent loops.

Invalid imports or declarations fail generation/setup. The implementation uses process watching and startup validation;
it does not introduce a separate atomic router-swap protocol or a promise that an already running process stops dispatch
before a filesystem rebuild begins.

### Production

Production startup never generates or hot reloads operations. `appkitServerConfig()` includes the generated registry,
schema, and operation modules. Plain Node first looks for a compiled registry beside the server entry, such as
`dist/database/routes.gen.js`; a source-less server bundle can therefore serve operations without `server/` or
`config/` TypeScript sources.

A custom build must include the registry beside its server with the same extension, or import it and pass
`database({ routes: databaseRoutes })`. Without a compiled registry, conventional source loading remains available;
production TypeScript loading uses Jiti. An explicit schema must be the same schema object used by an explicit registry.

Setup loads and validates declarations before opening a pool. Missing authorization skips only the affected otherwise
valid operation at runtime. Malformed or duplicate declarations, unknown entities, import errors, and invalid registry
exports fail setup. A missing/empty source directory is distinct from a broken expected artifact. Nothing restores CRUD.

## HTTP contract

The operation namespace bypasses the server's global JSON parser using the same routed-path semantics as dispatch.
The operation handler controls ordering and limits:

1. Set `Cache-Control: no-store`, resolve the actor, and check the browser origin boundary.
2. Match the explicit name and exact declared method. Unknown names or wrong methods give 404 after authentication.
3. Decode and validate input, then evaluate authorization.
4. Execute at most once and parse/project the output before sending it.

GET accepts no input or one URL-encoded JSON `input` query parameter, with an 8 KiB query limit. Other methods accept
an optional JSON body up to 1 MiB and no query parameters. Cross-origin browser requests are refused. A GET operation
must remain side-effect-free; the method cannot mechanically prove its executor is a read.

| Condition | Response |
|---|---|
| Success | 200; POST uses 201; default DELETE uses 204 without a body |
| Malformed transport or explicit input-schema failure | 400 |
| No actor / denied / missing operation or resource | 401 / 403 / 404 as specified above |
| Database constraint conflict | 409 |
| Oversized body / unsupported media type | 413 / 415 |
| Database entity validation failure | 422; distinct from operation input parsing |
| Transient service/database failure | 503 |
| Invalid or unusable output | Opaque 500; a write that returned from execute carries `outcome: "unknown"`, except its normal not-found result |

Errors use `{ error: "<stable message>" }`. Input-schema failures can add bounded `details: [{ path, message }]` for
forms. Paths include declared property names and array indices, not submitted dictionary keys or unknown fields.
Messages use safe fixed descriptions rather than raw Zod/refinement messages. Input values, resource contents, and raw
exception text are not returned. An unknown write outcome is not permission to retry automatically.

## Browser client and React hooks

```tsx
import { databaseApi } from "@databricks/appkit-ui/js/beta";
import {
  skipToken,
  useDatabaseMutation,
  useDatabaseQuery,
} from "@databricks/appkit-ui/react/beta";

const all = useDatabaseQuery("notes.list");
const selected = useDatabaseQuery(
  "notes.get",
  selectedId === null ? skipToken : { id: selectedId },
);
const create = useDatabaseMutation("notes.create");
const { error } = await create.mutate({ body: draft });
if (error === null) setDraft("");

// Imperative callers use the same generated contract.
const note = await databaseApi.execute("notes.get", { id: 7 });
```

The snippets illustrate hook and submit-handler calls; hooks run in React components and `mutate` in the handler.
Names and payloads come from `database-operations.d.ts`. Query hooks accept GET names; mutations accept non-GET names.
A no-parameter operation needs only its name, or `mutate()` for a write. Pass `undefined` in the input slot when supplying
query/request options. A name absent from boot metadata fails with `NOT_EXPOSED` without a request.

### Queries

`useDatabaseQuery` returns `data`, `error`, `isLoading`, and `refetch`. A new name, input, or session clears state and
replaces the read. An equal encoded input preserves the current request. Refetch keeps current data visible. Unmount
aborts the read, and late responses from superseded requests cannot populate the hook. Each mounted hook owns its
request; results and pending calls are not deduplicated or cached between hooks.

For a dependent query, `skipToken` represents an input that is not ready. It clears data/error, stays idle, sends no
request, and makes refetch a no-op. Entering that state aborts an old read and ignores its late answer. It is accepted
only by query hooks; imperative calls and mutations still require their declared payloads.

### Mutations

`useDatabaseMutation` sends nothing until `mutate`. It resolves `{ data, error }` and never rejects, retries, queues,
deduplicates, or aborts a write. Only the latest call updates hook state; `reset` returns to idle. Disable repeated
submissions while loading when the application requires it, and retain the user's draft on failure.

Mutation state belongs to the operation identity and session. Switching A to B, including switching back to A, does not
revive A's old pending state or result. Earlier writes finish; their result does not populate the newly selected hook.
Same-session success or unknown outcome refreshes mounted reads even when the originating hook changed or unmounted.
All mounted queries are invalidated, without a dependency DSL; active queries retain their data during refresh and
skipped/disabled queries remain gated.

### Sessions and imperative use

Authenticated responses carry an opaque actor discriminator derived from the workspace and verified actor ID. A new
actor or a 401 advances the client's session state, clears hooks, and rejects late results from an earlier session as
`SESSION_CHANGED`. Detection is response-driven; this is not a push notification of an identity change before any
response arrives.

`databaseApi.execute` rejects with `DatabaseApiError` on failure and supports an optional AbortSignal. A write with a
lost or unusable response can report `OUTCOME_UNKNOWN`; cancellation cannot undo a committed write. React callers
should prefer hooks for rendered database state. Imperative callers own request identity, state updates, cancellation,
and refresh after writes.

## Observability and boundaries

The handler creates a `database.operation` span across actor resolution, routing, input, policy, execution, and output.
It records the method, matched operation name, outcome, failure stage, and status. Lower work runs with tracing
suppressed to prevent SQL, row values, tokens, and raw exception messages from entering nested spans. Operation HTTP
instrumentation redacts query-bearing attributes. Failure logging uses bounded categories rather than raw callback or
driver messages, and policy denial reasons are excluded.

Operations do not use automatic execution cache/retry interceptors. Authorization cannot be skipped by a cache hit,
and a transient write is not automatically replayed. An executor can still perform multiple actions or external side
effects; at-most-once invocation is not exactly-once delivery or application idempotency.

The privacy contract applies to AppKit's operation path. App-authored logs, other plugins, and proxy telemetry need
their own handling. GET URLs should contain no secrets. A trusted executor can still copy private data into a declared
custom output or write an incorrect policy; neither the schema nor the SDK is a sandbox.

## Validation and remaining integration work

The implementation PRs record build, docs build, lint/format, and monorepo typecheck results, plus focused server, UI,
contract-generation, and playground suites. Coverage includes missing/malformed policies, concealed denials, safe input
errors, private projection, unsupported contracts, exact methods, transport limits, mutation/session identity,
`skipToken`, shared-file watching, first/last route changes, and a plain-Node source-less server bundle.

The local AML evaluation exercises more complex domain and UI scenarios, including transactional audit and concurrency
rules. AML is a local ignored test application and is excluded from every PR. Its local database checks do not establish
live Databricks Apps proxy behavior.

Before production release, validate forwarded-token scopes and proxy/header behavior in the actual Apps deployment,
verify the deployed origin/session boundary, and integrate the separate migration flow if shipping both designs.
Repository tests and packaging proofs do not substitute for those platform checks. No current product decision depends
on inferring output cardinality from input or reintroducing legacy CRUD.

## PR stack

Design first, then the existing implementation layers, bottom to top:

| Order | PR | Responsibility |
|---|---|---|
| 00 | [#683](https://github.com/databricks/appkit/pull/683) | This design and the current author experience |
| 01 | [#687](https://github.com/databricks/appkit/pull/687) | Remove lifecycle hooks, serialize, and their callers |
| 02 | [#688](https://github.com/databricks/appkit/pull/688) | Typed operation and reusable policy definitions; explicit input, retained output defaults |
| 03 | [#689](https://github.com/databricks/appkit/pull/689) | Actor, authorization, HTTP execution, and safe field-validation details |
| 04 | [#690](https://github.com/databricks/appkit/pull/690) | Discovery, generated browser contracts, empty registry, and shared-file generation |
| 05 | [#691](https://github.com/databricks/appkit/pull/691) | Typed browser client, query/mutation hooks, session/operation identity, and skipToken |
| 06 | [#692](https://github.com/databricks/appkit/pull/692) | Default route discovery, serving/build cutover, real watcher integration, and first-party app/docs migration |

Each implementation PR remains independently reviewable against its preceding layer. The final layer replaces legacy
HTTP exposure and first-party callers together. The design-only bottom layer does not enable operations by itself.

## Implementation source map

These paths refer to the complete operation stack:

- `packages/appkit/src/plugins/database/operations.ts`: descriptor, policy, context, and wire types.
- `packages/appkit/src/plugins/database/operation-metadata.ts`: shared declaration validation.
- `packages/appkit/src/plugins/database/operation-actor.ts`: verified identity and origin boundary.
- `packages/appkit/src/plugins/database/operation-runtime.ts` and `operation-validation.ts`: request execution and safe errors.
- `packages/appkit/src/plugins/database/load-routes.ts`: default source/compiled registry loading.
- `packages/appkit/src/type-generator/database/`: discovery and browser contract rendering.
- `packages/appkit/src/type-generator/vite-plugin.ts` and `packages/appkit/src/tsdown/index.ts`: watch and build integration.
- `packages/appkit-ui/src/js/database/` and `packages/appkit-ui/src/react/hooks/`: browser and hook behavior.
- `docs/docs/plugins/database.md`: current user guide and complete client error table.
