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

An env var can be declared in three places — the local env file, `app.yaml`, and
`databricks.yml` — so a bare "X is not set" is ambiguous about which one is
meant. This layer only ever means the **local env file**, and says so by name:
`X is not set in .env` (or the `--env-file` path when one was passed). The
complementary deploy-side finding is the wiring layer's `ENV_UNWIRED`, below.

The hint appears only when it has something to add. When `app.yaml` already
wires the var, deploy is fine and "set it locally" is just the detail line again,
so there's **no hint at all** — the row stays one line. Only a var that's *also*
unwired earns the "wire it through app.yaml + databricks.yml" advice, and then
`app.yaml` is named because it's genuinely the thing to fix.

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

A bundle-managed resource short-circuits **before** the config and existence
layers, because neither can say anything true about it: the value arrives from
`${resources.*}` at deploy time, so an unset env var locally is the *normal*
pre-deploy state rather than a config error. Its only layer is the
`BUNDLE_MANAGED` skip — which is also the fact a `--json` consumer or agent wants:
this resource is created on deploy.

Nothing is lost by skipping those layers. A mismatch across
`appkit.plugins.json` ↔ `app.yaml` ↔ `databricks.yml` is caught by the wiring
layer, and problems *inside* `databricks.yml` are `databricks bundle validate`'s
job.

> This ordering is load-bearing. Running `checkConfig` first meant an unset var
> errored and returned early, never reaching the bundle-managed branch — so a
> correctly configured app exited 1 while the report collapsed the row to a
> green-looking *will be created on deploy* and dropped the error layer, leaving
> `1 error` in the summary with no visible cause.

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
- `ENV_UNWIRED` — a plugin needs an env var no `app.yaml` entry provides, so it
  won't be set in the environment of the deployed app. Error for a required
  resource (a guaranteed break), warning for an optional one.

A wiring `error` gates the exit code, so `appkit doctor` catches deploy-breaking
misconfiguration pre-deploy.

### Setup notices (`checkSetup` in `run.ts`)

A warning about doctor's *own inputs*, which otherwise produce a misleading
report. `appkit.plugins.json` is the signal for "this is an app root", and the
two notices are **mutually exclusive** — at most one is emitted:

- `NO_RESOURCES_CHECKED` — no `appkit.plugins.json`, so zero resources were
  checked. This is the wrong-directory case: `cd server && appkit doctor`
  previously printed a bare green tick and exited **0** having checked nothing,
  which is worse than a failure — a CI gate passing an app it never looked at.
  Keyed off the file's *presence*, not the target count, since a manifest
  declaring no resources is legitimate.
- `ENV_FILE_MISSING` — a manifest exists (so this *is* an app root) but there's no
  `./.env`. The CLI's `import "dotenv/config"` reads only the cwd's `.env`
  (dotenv does no upward search), so local values could only have come from the
  shell. Suppressed when `--env-file` is passed, since a missing explicit file
  already throws in the CLI.

Without a manifest there's one cause worth reporting — you're in the wrong
directory — so the `.env` notice is withheld as noise on top of it. With a
manifest present it earns its place: it explains every `is not set in .env` error
beneath it.

**Warnings, not errors**: an app may legitimately have no `.env` (values exported
in the shell, or running inside a deployed container), so this must not fail a
build on its own.

`SetupFinding` is an alias of `WiringFinding`, so `report.ts` renders both with
one code path.

## 403 is ambiguous, and the copy says so

Several APIs — jobs and warehouses among them — return **403 for a resource that
doesn't exist**, not just for one you can't read. Verified against a live
workspace: `jobs.get` on a nonexistent id returns 403 identically to a job you
lack access to. So `ACCESS_DENIED` reports both possibilities:

```
"12345" not found, or you don't have access to it
```

The alternative — asserting "no permission" — sends you to request access to a
resource that may simply be a typo.

> A more precise split is *possible*: `permissions.get` returns 404 for an absent
> job and 403 for one that exists but you can't read (reading an ACL needs
> `CAN_MANAGE`). It's deliberately **not** used here — that behaviour was
> confirmed on a single identity in one workspace, and a workspace that returns
> 404-for-unauthorized would make doctor assert a resource doesn't exist when it
> does. Not a claim worth risking in a CI gate without broader verification.

## Report rendering (`report.ts`)

One flat, severity-sorted checklist — no titled sub-sections (which read as
inconsistent next to the header-less `Auth` row). `Auth` is always the first
row; every resource and wiring finding follows in the same list, sorted
most-severe first. Bundle-managed resources appear as *will be created on
deploy* rather than a probe result — but any non-`ok` layer they *do* carry is
still printed beneath them, so a row can never show a clean glyph while
contributing an invisible error to the summary. (`BUNDLE_MANAGED` itself is the
one code held back, since it would only restate the row's own label.)

Optimised for a quiet happy path: a healthy resource is just a green tick and
its name — no plugin/type attribution, no per-layer output. Detail (and a
`Hint:`, offset by a blank line so it sits apart from the error) appears only
beneath rows that aren't `ok`. There's no header block; the host and profile in
play are shown only when auth *fails or warns* (attached under the auth row,
where they're the first thing to sanity-check).

Colour (via `picocolors`) uses one tight palette:

- **glyphs** carry status — green `✓` / yellow `⚠` / red `✗` / dim `•`;
- **cyan** marks a literal token you'd type or reference — a `"quoted"` id or
  binding name, or a `` `backticked` `` code/command span;
- **bold** marks a `SCREAMING_SNAKE` env-var name (bold + cyan when it sits
  inside a code span — the bold pass must run *before* the cyan ones, or the
  inserted ANSI escapes break the `\b` anchor and the nesting silently stops
  working);
- resource *names* are left unstyled — only the id/code you'd act on is coloured.

`picocolors` auto-disables for non-TTY output and honours `NO_COLOR`, so
piped/CI output is plain text.

### Auth outcomes

Host and credentials aren't resolved by doctor — an empty `WorkspaceClient({})`
defers to the SDK's unified-auth chain (explicit env, then the selected
`~/.databrickscfg` profile, then OAuth). `--profile` is forwarded via
`Config.profile`; with neither host nor profile set, the SDK falls back to the
default profile. Doctor emits:

| Code | When | Detected |
| ---- | ---- | -------- |
| `HOST_INVALID` | `DATABRICKS_HOST` set but malformed / placeholder | offline, before any network |
| `SDK_NOT_INSTALLED` | Databricks SDK not resolvable | client build |
| `AUTH_OK` | `currentUser.me()` succeeded | live |
| `HOST_PROFILE_CONFLICT` (warn) | `me()` succeeded, but env host ≠ profile host | offline + live |
| `AUTH_FAILED` | `me()` threw | live |

#### Host/profile resolution — why both are reported

The SDK resolves auth **per field**, not per source: `EnvironmentLoader` runs
first, then `KnownConfigLoader` fills only attributes the environment left unset
(it explicitly won't overwrite a value already set). So `DATABRICKS_HOST` always
wins the host, while a named profile can still supply the credentials — a silent
mix where you authenticate with one workspace's token against another's URL.
(With no profile named *and* a host already configured, the config file is
skipped outright, not merged.)

Because of that, a failed or conflicted auth row reports **both** `host:` and
`profile:`. The host shown is the one the SDK actually resolved, read from
`client.config.host` — which the SDK populates lazily on the first API call, so
it's read *after* `me()`, not at construction. When the client never got built,
the host is recovered from the `host=…` fragment the SDK appends to its
`ConfigError`; failing that, it falls back to `DATABRICKS_HOST`. Every path is
passed through `sanitizeHost`, so embedded `user:pass@` credentials can't leak.

`HOST_PROFILE_CONFLICT` compares `DATABRICKS_HOST` against the profile's own
declared host, read offline from `~/.databrickscfg` via the SDK's exported
`loadConfigFile` (the resolved config is useless here — env has already won).
Comparison ignores scheme, case, and trailing slash. It's a **warning**, not an
error: the credentials do work, so it must not gate CI, but a green tick would
hide a real misconfiguration. When auth *also* fails, the conflict replaces the
generic login hint, since it's the better explanation.

`AUTH_FAILED` carries an action-first `hint` inferred from the SDK message
(workspace unreachable, profile not found, expired login / no credentials). Each
hint says what to *run* and to confirm the profile/host actually in use — a
failure can mean the wrong target, not just a stale token. `detail` is the short
headline `authentication failed`; the full SDK message is kept in `raw` and shown
only with `--detail` — in both the human report and `--json` (i.e. `--json`
alone omits `raw`, since it can carry sensitive detail and CI often captures it;
`--json --detail` opts back in). The report labels hints `Hint:`.

### Never echo the raw host

`DATABRICKS_HOST` is stored with any embedded `user:pass@` userinfo stripped, so
credentials never reach the report or JSON. Two rules keep that true:

- `sanitizeHost` strips userinfo via `URL` when the value parses, and textually
  when it doesn't — a typo'd scheme (`ht!tp://user:pass@x`) skips the URL path
  entirely and would otherwise be echoed verbatim.
- `validateHost` quotes the **sanitized** value in all three of its messages.
  `detail` prints unconditionally in both the human report and `--json` (only
  `raw` is `--detail`-gated), so a raw echo there lands in CI logs.

`HOST_INVALID` rejects only a hostname with no alphanumeric character at all
(the template's unfilled `https://...`). It deliberately does *not* require a
dotted label — that rejected `localhost`, tunnels, and internal DNS names, all of
which are legitimate.

## Files

- `types.ts` — the contract: layers, statuses, `ResourceTarget`, `DoctorReport`.
- `resolve-targets.ts` — reads `appkit.plugins.json` → `ResourceTarget[]`.
- `bundle.ts` — reads `databricks.yml` + `app.yaml` for binding provenance
  (external vs bundle-managed) and the env↔binding wiring map.
- `databricks-client.ts` — the sole SDK seam: dynamic `import()` of the SDK /
  `@databricks/appkit`, builds a `WorkspaceClient` and Lakebase pool, reads a
  profile's declared host for the conflict check, graceful fallback when
  uninstalled.
- `checks.ts` — `checkAuth`, `checkConfig` (the latter takes a
  `ConfigCheckContext` carrying the env-file name and the wired env vars, so its
  message names the right file and it only hints when wiring is actually wrong).
- `checks-existence.ts` — per-type existence probe dispatch + error classifier.
- `checks-wiring.ts` — offline three-file join / bundle-ref consistency check.
- `run.ts` — orchestration: auth once → overlay origin → per resource
  (config → existence, skipping bundle-managed) → wiring check → setup notices
  (`checkSetup`: missing manifest, else missing `.env`).
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
check, wiring findings, and setup notices — so a `--json` consumer can trust
`summary.error === 0` to mean "nothing failed". The report also carries a
top-level `exitCode` (0/1) as the single unambiguous pass/fail signal. Both are
computed once in `runDoctor`, so `--json` and the human report never disagree.
A `--json` consumer that needs to know whether doctor actually *looked* at
anything should check `setup` (or `resources.length`), not just `summary.error`.

Checks run as the identity that runs doctor (the developer locally, the app in
deployment).

## Existence coverage

Control-plane `.get()` for `sql_warehouse`, `serving_endpoint`, `genie_space`,
`job`, `volume`, `vector_search_index`, and `uc_function`; a real `SELECT 1`
connection for `postgres`/Lakebase. Other types report `skipped`.

Requires live credentials (a configured Databricks profile/token).
