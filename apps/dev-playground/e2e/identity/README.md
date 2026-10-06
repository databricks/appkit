# Execution identity e2e suite

End-to-end checks that AppKit runs each call as the right principal: the app
service principal (SP) by default, the signed-in user on the on-behalf-of (OBO)
path. Built on [`e2e`](https://www.npmjs.com/package/e2e) with the
`@e2edev/web` engine.

Requires the execution-identity stack (#592, #594, #595, #597, #601). On `main`
without it, the `appkit.asUser(req)` routes in `app/server.ts` do not exist.

## How identity is injected

The runner starts `app/server.ts` as a production server (`NODE_ENV=production`;
development mode would turn a missing user token into a silent SP run). Requests
carry the headers the Databricks Apps proxy forwards for a signed-in user:
`x-forwarded-access-token`, `x-forwarded-user`, `x-forwarded-email`. API checks
send them with `fetch`; browser steps get them from `web({ headers })` in
`e2e.config.ts`. The server authenticates as a real SP through
`DATABRICKS_CLIENT_ID` / `DATABRICKS_CLIENT_SECRET`, so the SP and the user are
different principals and every check can fail.

All assertions are deterministic. B5 sends a chat turn to the app's own agent;
its serving-endpoint model picks the tools, and the test reads the tool outputs
from the SSE stream, never the model's text. No e2e model provider is needed.

## Run

```sh
cd apps/dev-playground
export DATABRICKS_HOST=https://<workspace>
export E2E_SP_CLIENT_ID=<sp application id> E2E_SP_CLIENT_SECRET=<sp oauth secret>
export E2E_USER_EMAIL=<you@example.com>
export E2E_USER_TOKEN=$(databricks auth token --profile <profile> | jq -r .access_token)
export DATABRICKS_WAREHOUSE_ID=<id> DATABRICKS_SERVING_ENDPOINT_NAME=<endpoint>
export LAKEBASE_ENDPOINT=<projects/.../endpoints/...> PGHOST=<host> PGDATABASE=<db>
pnpm test:e2e                 # all tests
pnpm test:e2e analytics       # one file
```

**Local mode (no SP secret).** Leave `E2E_SP_CLIENT_ID` / `E2E_SP_CLIENT_SECRET`
unset and the server runs on `E2E_USER_TOKEN`. SP and user are then the same
principal, so the 7 tests that compare them skip with
`needs a distinct SP`; the principal-kind, fail-closed, app-only, and
deprecation checks still run.

The SP needs `CAN USE` on the warehouse, `CAN QUERY` on the endpoint, and a
Lakebase role. The app log is `.e2e/logs/identity-app.log`.

## Checklist mapping

| Checklist row | File | Test |
| --- | --- | --- |
| B1 `.sql` runs as SP | `analytics.e2e.ts` | B1: a .sql query runs as the app service principal |
| B2 `.obo.sql` runs as user | `analytics.e2e.ts` | B2: a .obo.sql query runs as the signed-in user |
| B3 `asUser(req).run(...)` | `as-user.e2e.ts` | B3: asUser(req).run(...) runs as the user |
| B3 one-call form | `as-user.e2e.ts` | B3: the one-call asUser(req).plugin.method() form runs as the user |
| B4 plain call runs as SP | `as-user.e2e.ts` | B4: a plain plugin call runs as the SP even with user headers |
| B5 toolkit tool as user | `agents.e2e.ts` | B5: a plugin-toolkit tool runs as the user |
| B5 hand-rolled tool and model as SP | `agents.e2e.ts` | B5: a hand-rolled tool and the model call run as the SP |
| B7 Lakebase always SP | `lakebase.e2e.ts` | B7: a Lakebase query connects as the SP even with user headers |
| B7 Lakebase is app-only | `lakebase.e2e.ts` | B7: asUser(req).lakebase is refused, never run as the user |
| Guardrail: fail-closed (asUser) | `as-user.e2e.ts` | fail-closed: asUser with no user token rejects instead of running as the SP |
| Guardrail: fail-closed (agent tool) | `agents.e2e.ts` | fail-closed: a plugin tool call with no user token never runs as the SP |
| Guardrail: no `Plugin.asUser` deprecation from core plugins | `deprecation.e2e.ts` | core plugins on the OBO path log no Plugin.asUser deprecation warning |

B6 (unbound-warehouse OBO) and Part A (provisioning) need a deployed app or the
CLI and are not covered here.

## How this differs from `server/testing-kit.integration.test.ts`

That suite runs in-process against a mocked workspace client: it proves AppKit
routes a call to the user or SP context. This suite sends real HTTP through the
proxy-header path to a real workspace, so it proves which principal the
warehouse, Lakebase, and the agent's tools actually see.
