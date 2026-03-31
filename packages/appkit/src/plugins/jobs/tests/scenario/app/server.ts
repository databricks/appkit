/**
 * Sample AppKit app demonstrating the jobs plugin.
 *
 * A Mock Jobs API server that simulates the Databricks Jobs lifecycle:
 * job submission, status polling, cancellation, and output retrieval.
 * Used for scenario testing without real Databricks API calls.
 */

import express from "express";

interface MockRun {
  run_id: number;
  run_name: string;
  state: {
    life_cycle_state: string;
    result_state?: string;
    state_message: string;
  };
  tasks: Array<{
    task_key: string;
    state: { life_cycle_state: string; result_state?: string };
  }>;
  start_time: number;
  end_time?: number;
}

const runs = new Map<number, MockRun>();
let nextRunId = 1000;

const app = express();
app.use(express.json());

// POST /api/jobs/submit — simulate submitRun
app.post("/api/jobs/submit", (req, res) => {
  const { run_name, tasks } = req.body;
  const runId = nextRunId++;
  const run: MockRun = {
    run_id: runId,
    run_name: run_name ?? `run-${runId}`,
    state: {
      life_cycle_state: "PENDING",
      state_message: "Run is pending",
    },
    tasks: (tasks ?? []).map((t: any) => ({
      task_key: t.task_key,
      state: { life_cycle_state: "PENDING" },
    })),
    start_time: Date.now(),
  };
  runs.set(runId, run);

  // Auto-transition to RUNNING after creation
  setTimeout(() => {
    const r = runs.get(runId);
    if (r && r.state.life_cycle_state === "PENDING") {
      r.state.life_cycle_state = "RUNNING";
      r.state.state_message = "Run is executing";
      for (const t of r.tasks) {
        t.state.life_cycle_state = "RUNNING";
      }
    }
  }, 100);

  // Auto-transition to TERMINATED/SUCCESS after 500ms
  setTimeout(() => {
    const r = runs.get(runId);
    if (r && r.state.life_cycle_state === "RUNNING") {
      r.state.life_cycle_state = "TERMINATED";
      r.state.result_state = "SUCCESS";
      r.state.state_message = "Run completed successfully";
      r.end_time = Date.now();
      for (const t of r.tasks) {
        t.state.life_cycle_state = "TERMINATED";
        t.state.result_state = "SUCCESS";
      }
    }
  }, 500);

  res.json({ run_id: runId });
});

// GET /api/jobs/runs/:runId — simulate getRun
app.get("/api/jobs/runs/:runId", (req, res) => {
  const runId = parseInt(req.params.runId);
  const run = runs.get(runId);
  if (!run) {
    return res.status(404).json({ error: `Run ${runId} not found` });
  }
  res.json(run);
});

// GET /api/jobs/runs — list all runs
app.get("/api/jobs/runs", (_req, res) => {
  res.json({ runs: Array.from(runs.values()) });
});

// POST /api/jobs/runs/:runId/cancel — cancel a run
app.post("/api/jobs/runs/:runId/cancel", (req, res) => {
  const runId = parseInt(req.params.runId);
  const run = runs.get(runId);
  if (!run) {
    return res.status(404).json({ error: `Run ${runId} not found` });
  }
  run.state.life_cycle_state = "TERMINATED";
  run.state.result_state = "CANCELED";
  run.state.state_message = "Run was canceled";
  run.end_time = Date.now();
  res.json({});
});

// GET /api/health
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", plugin: "jobs" });
});

// HTML UI — simple dashboard showing runs
app.get("/", (_req, res) => {
  const allRuns = Array.from(runs.values());
  const rows = allRuns
    .map(
      (r) =>
        `<tr>
          <td>${r.run_id}</td>
          <td>${r.run_name}</td>
          <td>${r.state.life_cycle_state}</td>
          <td>${r.state.result_state ?? "-"}</td>
          <td>${r.tasks.length}</td>
        </tr>`,
    )
    .join("");

  res.send(`<!DOCTYPE html>
<html>
<head><title>Jobs Dashboard</title></head>
<body>
  <h1>Jobs Dashboard</h1>
  <p>Total runs: <span id="run-count">${allRuns.length}</span></p>
  <button id="submit-btn" onclick="submitRun()">Submit Run</button>
  <table>
    <thead>
      <tr><th>Run ID</th><th>Name</th><th>State</th><th>Result</th><th>Tasks</th></tr>
    </thead>
    <tbody id="runs-table">${rows}</tbody>
  </table>
  <script>
    async function submitRun() {
      const resp = await fetch('/api/jobs/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          run_name: 'test-run',
          tasks: [{ task_key: 'main', notebook_task: { notebook_path: '/test' } }]
        })
      });
      const data = await resp.json();
      document.getElementById('run-count').textContent =
        String(parseInt(document.getElementById('run-count').textContent) + 1);
      location.reload();
    }
  </script>
</body>
</html>`);
});

const port = parseInt(process.env.PORT ?? "3001");
app.listen(port, () => {
  console.log("Jobs scenario app running on http://localhost:" + port);
});
