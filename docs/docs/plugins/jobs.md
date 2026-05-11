---
sidebar_position: 8
---

# Jobs plugin

Trigger and monitor [Databricks Lakeflow Jobs](https://docs.databricks.com/en/jobs/index.html) from your AppKit application.

**Key features:**
- Multi-job support with named job keys
- Auto-discovery of jobs from environment variables
- Run-and-wait with SSE streaming status updates
- Parameter validation with Zod schemas
- Task-type-aware parameter mapping (notebook, python_wheel, sql, etc.)
- Optional on-behalf-of (OBO) user execution via `.asUser(req)`

## Basic usage

```ts
import { createApp, server, jobs } from "@databricks/appkit";

await createApp({
  plugins: [server(), jobs()],
});
```

With no explicit `jobs` config, the plugin reads `DATABRICKS_JOB_ID` from the environment and registers it under the `default` key.

## Configuration options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `timeout` | `number` | `60000` | Default timeout for Jobs API calls in ms |
| `pollIntervalMs` | `number` | `5000` | Poll interval for `runAndWait` in ms |
| `jobs` | `Record<string, JobConfig>` | — | Named jobs to expose. Each key becomes a job accessor |

### Per-job config (`JobConfig`)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `waitTimeout` | `number` | `600000` | Override the polling timeout for this job |
| `taskType` | `TaskType` | — | Task type for automatic parameter mapping |
| `params` | `z.ZodType` | — | Zod schema for runtime parameter validation |

## Environment variables

### Single-job mode

Set `DATABRICKS_JOB_ID` to expose one job under the `default` key:

```env
DATABRICKS_JOB_ID=123456
```

```ts
const handle = AppKit.jobs("default");
```

### Multi-job mode

Set `DATABRICKS_JOB_<NAME>` for each job:

```env
DATABRICKS_JOB_ETL=123456
DATABRICKS_JOB_ML=789012
```

```ts
const etl = AppKit.jobs("etl");
const ml  = AppKit.jobs("ml");
```

Environment variable names are uppercased; job keys are lowercased. Jobs discovered from the environment are merged with any explicit `jobs` config — explicit config wins.

## Parameter validation

Use `params` to enforce a Zod schema at runtime. Invalid parameters are rejected with a `400` before the job is triggered:

```ts
import { z } from "zod";

jobs({
  jobs: {
    etl: {
      params: z.object({
        startDate: z.string(),
        endDate: z.string(),
        dryRun: z.boolean().optional(),
      }),
    },
  },
})
```

## Task type mapping

When `taskType` is set, the plugin maps validated parameters to the correct SDK request fields automatically:

| Task type | SDK field | Parameter shape |
|-----------|-----------|-----------------|
| `notebook` | `notebook_params` | `Record<string, string>` — values coerced to string |
| `python_wheel` | `python_named_params` | `Record<string, string>` — values coerced to string |
| `python_script` | `python_params` | `{ args: string[] }` — positional args |
| `spark_jar` | `jar_params` | `{ args: string[] }` — positional args |
| `sql` | `sql_params` | `Record<string, string>` — values coerced to string |
| `dbt` | — | No parameters accepted |

```ts
jobs({
  jobs: {
    etl: {
      taskType: "notebook",
      params: z.object({
        startDate: z.string(),
        endDate: z.string(),
      }),
    },
  },
})
```

When `taskType` is omitted, parameters are passed through to the SDK as-is.

## Execution context

HTTP routes run as the **app's service principal** by default. Jobs are typically shared infrastructure, and the app's resource binding (`databricks.yml`) grants `CAN_MANAGE_RUN` to the SP — so users trigger runs without needing individual grants.

Per-run attribution in the Jobs UI will show the app's SP, not the human user. If you need user-level attribution (or want the Databricks permission check to use the user's grants), opt in to OBO explicitly in a custom handler via `.asUser(req)`:

```ts
// Default: runs as the app's service principal
const result = await AppKit.jobs("etl").runNow({ startDate: "2025-01-01" });

// Opt-in: runs as the logged-in user (requires `jobs.jobs` in
// `databricks.yml` user_api_scopes AND the user's own CAN_MANAGE_RUN grant)
const result = await AppKit.jobs("etl").asUser(req).runNow({ startDate: "2025-01-01" });
```

## HTTP endpoints

All routes are mounted under `/api/jobs`.

### Trigger a run

```
POST /api/jobs/:jobKey/run
Content-Type: application/json

{ "params": { "startDate": "2025-01-01" } }
```

Returns `{ "runId": 12345 }`.

Add `?stream=true` to receive SSE status updates that poll until the run completes:

```
POST /api/jobs/:jobKey/run?stream=true
```

Each SSE event contains `{ status, timestamp, run }`.

### List runs

```
GET /api/jobs/:jobKey/runs?limit=20
```

Returns `{ "runs": [...] }`. Limit is clamped to 1–100, default 20.

### Get run details

```
GET /api/jobs/:jobKey/runs/:runId
```

### Get latest status

```
GET /api/jobs/:jobKey/status
```

Returns `{ "status": "TERMINATED", "run": { ... } }` for the most recent run.

### Cancel a run

```
DELETE /api/jobs/:jobKey/runs/:runId
```

Returns `204 No Content` on success.

## Programmatic access

The plugin exports a callable that selects a job by key:

```ts
const AppKit = await createApp({
  plugins: [
    server(),
    jobs({
      jobs: {
        etl: { taskType: "notebook" },
      },
    }),
  ],
});

const etl = AppKit.jobs("etl");

// Trigger a run
const result = await etl.runNow({ startDate: "2025-01-01" });
if (result.ok) {
  console.log("Run ID:", result.data.run_id);
}

// Trigger and poll until completion
for await (const status of etl.runAndWait({ startDate: "2025-01-01" })) {
  console.log(status.status); // "PENDING", "RUNNING", "TERMINATED", etc.
}

// Read operations
await etl.lastRun();
await etl.listRuns({ limit: 10 });
await etl.getRun(12345);
await etl.getRunOutput(12345);
await etl.getJob();

// Cancel
await etl.cancelRun(12345);
```

All methods return [`ExecutionResult<T>`](../api/appkit/TypeAlias.ExecutionResult.md) — check `result.ok` before accessing `result.data`.

## Execution defaults

| Tier | Cache | Retry | Timeout | Methods |
|------|-------|-------|---------|---------|
| Read | 60s TTL | 3 attempts, 1s backoff | 30s | `getRun`, `getJob`, `listRuns`, `lastRun`, `getRunOutput` |
| Write | Disabled | Disabled | 120s | `runNow`, `cancelRun` |
| Stream | Disabled | Disabled | 600s | `runAndWait` (SSE polling) |
