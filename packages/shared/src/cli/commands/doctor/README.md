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
only with `--detail` (always in `--json`). The report labels hints `Hint:`.

## Files

- `types.ts` — the contract: layers, statuses, `ResourceTarget`, `DoctorReport`.
- `resolve-targets.ts` — reads `appkit.plugins.json` → `ResourceTarget[]`.
- `databricks-client.ts` — the sole SDK seam: dynamic `import()` of the SDK /
  `@databricks/appkit`, builds a `WorkspaceClient` and Lakebase pool, graceful
  fallback when uninstalled.
- `checks.ts` — `checkAuth`, `checkConfig`, `checkExistence`.
- `checks-existence.ts` — per-type existence probe dispatch + error classifier.
- `run.ts` — orchestration: auth once → per resource (config → existence).
- `report.ts` — human table + `--json`, and the CI-gating exit code.
- `index.ts` — the Commander command + flags.

## Flags

- `--profile <name>` — Databricks CLI profile to authenticate with.
- `--json` — machine-readable report.

Exit code is non-zero if auth or any resource is in an `error` state, so
`appkit doctor` can gate CI / pre-deploy.

Checks run as the identity that runs doctor (the developer locally, the app in
deployment).

## Existence coverage

Control-plane `.get()` for `sql_warehouse`, `serving_endpoint`, `genie_space`,
`job`, `volume`, `vector_search_index`, and `uc_function`; a real `SELECT 1`
connection for `postgres`/Lakebase. Other types report `skipped`.

Requires live credentials (a configured Databricks profile/token).
