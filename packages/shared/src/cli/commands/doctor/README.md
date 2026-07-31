# `appkit doctor`

Diagnoses whether an AppKit app's declared Databricks resources are actually
usable — going beyond the startup env-var presence check to probe existence and
reachability against the live workspace.

## The check model — three layers

For each declared resource, doctor runs the offline `config` layer then the live
`existence` layer; `auth` runs once up front. It stops at the first hard failure
so the reported problem is the *root* cause, not a symptom.

| Layer        | Question                                              | How                                                        |
| ------------ | ----------------------------------------------------- | ---------------------------------------------------------- |
| `auth`       | Can we authenticate to the workspace at all?          | validate `DATABRICKS_HOST` is a real URL, then `currentUser.me()` — once, app-wide; a failure skips the live layer |
| `config`     | Are the resource's field env vars **present**?        | offline presence check of `process.env` (presence only — see note) |
| `existence`  | Does the resource exist and is it reachable?          | cheapest per-type live probe (`warehouses.get`, `servingEndpoints.get`, …); Lakebase runs a real `SELECT 1` |

`config` checks env-var presence only; whether a value points at a real resource
is the `existence` layer's job. (`DATABRICKS_HOST` is the exception — `auth`
validates it structurally, since a bad host means no client can be built.)

Every live call (`auth`'s `currentUser.me()` and each `existence` probe) is
bounded by a 10s wall-clock deadline (`withTimeout`). A reachable-but-unresponsive
endpoint must never hang doctor — it's a CI gate that has to return — so a
timeout surfaces as an error (`PROBE_TIMEOUT`, or an auth failure) rather than a
hung process. The race can't cancel the underlying request, but it stops doctor
*waiting* on it. (Lakebase connections are separately bounded at 10s by the
pool's `connectionTimeoutMillis`.)

## Which plugins are checked

`plugin sync` writes `appkit.plugins.json` cataloguing *every* plugin the
installed packages ship (for `apps init`), and marks the ones actually wired
into `createApp` with `requiredByTemplate: true`. Doctor checks exactly those, so
an unused built-in doesn't produce phantom "missing env var" errors.

> **Known limitation — non-GA plugins aren't checked yet.** `plugin sync` strips
> `requiredByTemplate` for beta/experimental plugins (its step 6b), so a *used*
> non-GA plugin (e.g. the agents plugin requiring a serving endpoint) is
> currently skipped. A proper fix needs a usage signal that survives sync
> regardless of stability tier (e.g. a separate `used` marker written before the
> strip); that's a `plugin sync` change tracked as a fast-follow. Until then,
> doctor covers GA plugins wired into your app.

## Resource provenance: external vs bundle-managed

Each resource is one of two kinds, which changes what doctor does with it:

- **external** — referenced by id/name (`${var.*}` or a literal in
  `databricks.yml`). It should exist now, so the live `existence` probe applies.
- **bundle-managed** — created by this bundle on deploy
  (`${resources.<type>.<key>.*}`). It doesn't exist until `bundle deploy`, so
  probing it would be a false `NOT_FOUND`; doctor reports it as *will be created
  on deploy* instead.

Provenance comes from `bundle.ts`, which reads `databricks.yml` + `app.yaml` and
classifies each binding, then overlays `origin` onto the manifest-sourced
targets. Apps with no `databricks.yml` behave exactly as before (everything
treated as external).

### Wiring check (`checks-wiring.ts`)

An offline, auth-independent check of the three-file join that
`databricks bundle validate` can't see (it doesn't know `app.yaml`↔plugin
wiring):

- `VALUEFROM_UNBOUND` — an `app.yaml` `valueFrom: <name>` matches no
  `databricks.yml` binding (the env var would never be injected).
- `BUNDLE_REF_MISSING` — a `${resources.<type>.<key>.*}` binding references a
  resource not declared in the bundle (deploy would fail).
- `ENV_UNWIRED` (warn) — a plugin needs an env var no `app.yaml` entry provides.

A wiring `error` gates the exit code, so `appkit doctor` catches deploy-breaking
misconfiguration pre-deploy.

## Report rendering (`report.ts`)

One flat, severity-sorted checklist — no titled sub-sections (which read as
inconsistent next to the header-less `Auth` row). `Auth` is always the first
row; every resource and wiring finding follows in the same list, sorted
most-severe first. Bundle-managed resources appear as *will be created on
deploy* rather than a probe result.

Optimised for a quiet happy path: a healthy resource is just a green tick and
its name — no plugin/type attribution, no per-layer output. Detail (and a
`Hint:`, offset by a blank line so it sits apart from the error) appears only
beneath rows that aren't `ok`. There's no header block; the profile in play is
shown only when auth *fails* (attached under the auth row, where it's the first
thing to sanity-check).

Colour (via `picocolors`) uses one tight palette:

- **glyphs** carry status — green `✓` / yellow `⚠` / red `✗` / dim `•`;
- **cyan** marks a literal token you'd type or reference — a `"quoted"` id or
  binding name, or a `` `backticked` `` code/command span;
- **bold** marks a `SCREAMING_SNAKE` env-var name (bold + cyan when it sits
  inside a code span);
- resource *names* are left unstyled — only the id/code you'd act on is coloured.

`picocolors` auto-disables for non-TTY output and honours `NO_COLOR`, so
piped/CI output is plain text.

### Auth outcomes

Host and credentials aren't resolved by doctor — an empty `WorkspaceClient({})`
defers to the SDK's unified-auth chain (explicit env, then the selected
`~/.databrickscfg` profile, then OAuth). `--profile` is forwarded via
`DATABRICKS_CONFIG_PROFILE`; with neither host nor profile set, the SDK falls
back to the default profile. Doctor emits:

| Code | When | Detected |
| ---- | ---- | -------- |
| `HOST_INVALID` | `DATABRICKS_HOST` set but malformed / placeholder | offline, before any network |
| `SDK_NOT_INSTALLED` | Databricks SDK not resolvable | client build |
| `AUTH_OK` | `currentUser.me()` succeeded | live |
| `AUTH_FAILED` | `me()` threw | live |

`AUTH_FAILED` carries an action-first `hint` inferred from the SDK message
(workspace unreachable, profile not found, expired login / no credentials). Each
hint says what to *run* and to confirm the profile/host actually in use — a
failure can mean the wrong target, not just a stale token. `detail` is the short
headline `authentication failed`; the full SDK message is kept in `raw` and shown
only with `--detail` — in both the human report and `--json` (i.e. `--json`
alone omits `raw`, since it can carry sensitive detail and CI often captures it;
`--json --detail` opts back in). `DATABRICKS_HOST` is stored with any embedded
`user:pass@` userinfo stripped, so credentials never reach the report or JSON.
The report labels hints `Hint:`.

## Files

- `types.ts` — the contract: layers, statuses, `ResourceTarget`, `DoctorReport`.
- `resolve-targets.ts` — reads `appkit.plugins.json` → `ResourceTarget[]`.
- `bundle.ts` — reads `databricks.yml` + `app.yaml` for binding provenance
  (external vs bundle-managed) and the env↔binding wiring map.
- `databricks-client.ts` — the sole SDK seam: dynamic `import()` of the SDK /
  `@databricks/appkit`, builds a `WorkspaceClient` and Lakebase pool, graceful
  fallback when uninstalled.
- `checks.ts` — `checkAuth`, `checkConfig`.
- `checks-existence.ts` — per-type existence probe dispatch + error classifier.
- `checks-wiring.ts` — offline three-file join / bundle-ref consistency check.
- `run.ts` — orchestration: auth once → overlay origin → per resource
  (config → existence, skipping bundle-managed) → wiring check.
- `report.ts` — runtime / deploy sections, `--json`, exit code.
- `index.ts` — the Commander command + flags.

## Flags

- `--profile <name>` — Databricks CLI profile to authenticate with.
- `--env-file <path>` — load an env file (e.g. `.env.local`) before checking.
- `--detail` — show full underlying error messages.
- `--json` — machine-readable report.

Exit code is non-zero if auth, any resource, or any wiring finding is in an
`error` state, so `appkit doctor` can gate CI / pre-deploy.

The report's `summary` counts *everything* with a status — resources, the auth
check, and wiring findings — so a `--json` consumer can trust
`summary.error === 0` to mean "nothing failed". The report also carries a
top-level `exitCode` (0/1) as the single unambiguous pass/fail signal. Both are
computed once in `runDoctor`, so `--json` and the human report never disagree.

Checks run as the identity that runs doctor (the developer locally, the app in
deployment).

## Existence coverage

Control-plane `.get()` for `sql_warehouse`, `serving_endpoint`, `genie_space`,
`job`, `volume`, `vector_search_index`, and `uc_function`; a real `SELECT 1`
connection for `postgres`/Lakebase. Other types report `skipped`.

Requires live credentials (a configured Databricks profile/token).
