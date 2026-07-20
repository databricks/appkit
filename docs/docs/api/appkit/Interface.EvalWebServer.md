# Interface: EvalWebServer

Auto-start config for the app under test, à la Playwright's `webServer`. When
set in a root `evals.config.ts`, the CLI boots the app before running evals
and tears it down after — so you don't have to start the server by hand.

## Properties

### command

```ts
command: string;
```

Shell command that starts the app, e.g. `"npm run dev"`.

***

### reuseExisting?

```ts
optional reuseExisting: boolean;
```

When `true` (default), reuse a server already answering at `url` instead of
spawning one — so a running `dev` server is used as-is. Set `false` to
always spawn a fresh server.

***

### timeoutMs?

```ts
optional timeoutMs: number;
```

How long to wait for `url` to answer before giving up. Defaults to 60s.

***

### url?

```ts
optional url: string;
```

URL polled until it answers before evals start. Defaults to the run's
`baseUrl` (`--url`). Readiness = any HTTP response (a 404 still proves the
server is up).
