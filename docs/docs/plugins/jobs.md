---
sidebar_position: 9
---

# Jobs plugin

Databricks Jobs API integration for submitting, monitoring, and managing job runs. Wraps the Jobs REST API with typed methods, integrated telemetry, retry, and timeout support.

**Key features:**
- **Submit one-time runs** — launch notebook, Python, JAR, or SQL tasks without creating a persistent job
- **Trigger existing jobs** — run pre-defined jobs with optional parameter overrides
- **Poll for completion** — `waitForRun` polls with exponential backoff until terminal state
- **Full lifecycle management** — create, get, list, cancel runs and jobs

## Basic usage

```ts
import { createApp, jobs, server } from "@databricks/appkit";

const app = await createApp({
  plugins: [
    server(),
    jobs(),
  ],
});
```

## Submit and wait for a run

```ts
// Submit a one-time notebook run
const { run_id } = await app.jobs.submitRun({
  run_name: "daily-analysis",
  tasks: [{
    task_key: "main",
    notebook_task: {
      notebook_path: "/Users/me/notebooks/analysis",
    },
  }],
});

// Poll until the run reaches a terminal state
const run = await app.jobs.waitForRun(run_id);
console.log(run.state?.result_state); // "SUCCESS"
```

## Trigger an existing job

```ts
// Run a pre-defined job by ID with parameter overrides
const { run_id } = await app.jobs.runNow({
  job_id: 12345,
  notebook_params: {
    date: "2025-01-15",
    mode: "full-refresh",
  },
});

const run = await app.jobs.waitForRun(run_id);
```

## Poll for status

```ts
// Check run state without blocking
const run = await app.jobs.getRun(run_id);

switch (run.state?.life_cycle_state) {
  case "PENDING":
  case "RUNNING":
    console.log("Still running...");
    break;
  case "TERMINATED":
    console.log("Result:", run.state.result_state);
    break;
  case "SKIPPED":
    console.log("Run was skipped");
    break;
  case "INTERNAL_ERROR":
    console.error("Internal error:", run.state.state_message);
    break;
}
```

## Get task output

```ts
const output = await app.jobs.getRunOutput(run_id);
console.log(output.notebook_output?.result);
```

## Cancel a run

```ts
await app.jobs.cancelRun(run_id);
```

## List runs for a job

```ts
const runs = await app.jobs.listRuns({
  job_id: 12345,
  active_only: true,
});

for (const run of runs) {
  console.log(`Run ${run.run_id}: ${run.state?.life_cycle_state}`);
}
```

## Create a job

```ts
const { job_id } = await app.jobs.createJob({
  name: "nightly-etl",
  tasks: [{
    task_key: "extract",
    notebook_task: {
      notebook_path: "/Users/me/notebooks/extract",
    },
  }, {
    task_key: "transform",
    depends_on: [{ task_key: "extract" }],
    notebook_task: {
      notebook_path: "/Users/me/notebooks/transform",
    },
  }],
  schedule: {
    quartz_cron_expression: "0 0 2 * * ?",
    timezone_id: "America/Los_Angeles",
  },
});
```

## Combining with other plugins

### Jobs + Files: upload artifacts for job input

```ts
import { createApp, jobs, files, server } from "@databricks/appkit";

const app = await createApp({
  plugins: [server(), jobs(), files()],
});

// Upload input data to a UC Volume
await app.files("staging").upload("input/params.json", Buffer.from(
  JSON.stringify({ threshold: 0.95, mode: "strict" }),
));

// Submit a run that reads from the volume
const { run_id } = await app.jobs.submitRun({
  run_name: "parameterized-run",
  tasks: [{
    task_key: "main",
    notebook_task: {
      notebook_path: "/Users/me/notebooks/process",
      base_parameters: {
        config_path: "/Volumes/catalog/schema/staging/input/params.json",
      },
    },
  }],
});
```

### Jobs + Lakebase: store results in database

```ts
import { createApp, jobs, lakebase, server } from "@databricks/appkit";

const app = await createApp({
  plugins: [server(), jobs(), lakebase()],
});

// Wait for job to finish, then query results
const run = await app.jobs.waitForRun(run_id);
if (run.state?.result_state === "SUCCESS") {
  const rows = await app.lakebase.query(
    "SELECT * FROM results WHERE run_id = $1",
    [run_id],
  );
  console.log(`Job produced ${rows.length} result rows`);
}
```

## API reference

| Method | Description |
| --- | --- |
| `submitRun(req)` | Submit a one-time run without creating a job |
| `runNow(req)` | Trigger an existing job by ID |
| `getRun(runId)` | Get run metadata and state |
| `getRunOutput(runId)` | Get task output (notebook result, logs) |
| `cancelRun(runId)` | Cancel a running or pending run |
| `listRuns(req)` | List runs for a job (supports filtering) |
| `getJob(jobId)` | Get job definition and settings |
| `createJob(req)` | Create a new job with tasks and schedule |
| `waitForRun(runId, timeoutMs?)` | Poll until terminal state (TERMINATED, SKIPPED, INTERNAL_ERROR) |

## Configuration

```ts
jobs()                           // Defaults: 60s timeout, 5s poll interval
jobs({ timeout: 120000 })        // 2 minute API timeout
jobs({ pollIntervalMs: 10000 })  // 10 second poll interval for waitForRun
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `timeout` | `number` | `60000` | Default timeout for Jobs API calls (ms) |
| `pollIntervalMs` | `number` | `5000` | Poll interval for `waitForRun` (ms) |
