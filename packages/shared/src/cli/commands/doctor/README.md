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
