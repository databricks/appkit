import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { deflateSync, gzipSync } from "node:zlib";

import { test } from "vitest";

import { createTestApp } from "../../../testing";
import { createWorkspaceClient } from "../../../workspace-client";
import { designer } from "../plugin";

async function listen(t, server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function harness(t, env = {}) {
  const revision = "a".repeat(64);
  const parameters = {
    _lb_runner_revision: revision,
    hidden: "published default",
    choice: "A",
  };
  const state = {
    requests: [],
    submissions: [],
    failAcceptedSubmission: false,
    cancellations: [],
    runs: [],
    manifest: {
      version: 8,
      appName: "Report",
      runner: { revision, parameters },
      parameters: [
        { name: "choice", label: "Choice", type: "text", defaultValue: "A" },
      ],
      blocks: [
        {
          type: "output",
          id: "out",
          nodeId: "source",
          port: "data",
          label: "Data",
        },
      ],
    },
    job: {
      settings: {
        tasks: [
          {
            notebook_task: {
              notebook_path: `/Users/author/app/runner-${revision}.designer.py`,
              base_parameters: { ...parameters },
            },
          },
        ],
      },
    },
  };
  const workspaceUrl = await listen(
    t,
    createServer(async (req, res) => {
      let text = "";
      for await (const chunk of req) text += chunk;
      const body = text ? JSON.parse(text) : undefined;
      const url = new URL(req.url, "http://workspace.test");
      state.requests.push({ method: req.method, path: url.pathname, body });
      assert.equal(req.headers.authorization, "Bearer test-only");
      res.setHeader("Content-Type", "application/json");
      const send = (value) => res.end(JSON.stringify(value));
      if (url.pathname.endsWith("/Me"))
        return send({ id: "app-service-principal" });
      if (url.pathname.endsWith("/jobs/get")) return send(state.job);
      if (url.pathname.endsWith("/workspace/export")) {
        return send({
          content: Buffer.from(JSON.stringify(state.manifest)).toString(
            "base64",
          ),
        });
      }
      if (url.pathname.endsWith("/jobs/run-now")) {
        const previous = state.submissions.find(
          (submission) =>
            submission.idempotency_token === body.idempotency_token,
        );
        if (previous) {
          const run = state.runs.find((run) =>
            run.job_parameters.some(
              ({ name, value }) =>
                name === "_lb_app_submission_id" &&
                value === previous.job_parameters._lb_app_submission_id,
            ),
          );
          return send({ run_id: run.run_id });
        }
        state.submissions.push(body);
        const run = {
          run_id: 1000 + state.submissions.length,
          job_id: 10,
          start_time: Date.now(),
          job_parameters: Object.entries(body.job_parameters).map(
            ([name, value]) => ({ name, value }),
          ),
          state: { life_cycle_state: "RUNNING" },
        };
        state.runs.unshift(run);
        if (state.failAcceptedSubmission) {
          state.failAcceptedSubmission = false;
          res.statusCode = 500;
          return send({
            error_code: "INTERNAL_ERROR",
            message: "Unexpected error",
          });
        }
        return send({ run_id: run.run_id });
      }
      if (url.pathname.endsWith("/jobs/runs/export"))
        return send({ views: [{ content: state.exportedHtml }] });
      if (url.pathname.endsWith("/jobs/runs/get")) {
        return send(
          state.runs.find(
            (run) => run.run_id === Number(url.searchParams.get("run_id")),
          ),
        );
      }
      if (url.pathname.endsWith("/jobs/runs/cancel")) {
        state.cancellations.push(body.run_id);
        return send({});
      }
      if (url.pathname.endsWith("/jobs/runs/list")) {
        const completed = url.searchParams.get("completed_only") === "true";
        const runs = state.runs.filter(
          (run) => Boolean(run.state.result_state) === completed,
        );
        const offset = Number(url.searchParams.get("page_token") || 0);
        const end = offset + Number(url.searchParams.get("limit") || 25);
        return send({
          runs: runs.slice(offset, end),
          ...(end < runs.length ? { next_page_token: String(end) } : {}),
        });
      }
      res.statusCode = 404;
      return send({ error_code: "NOT_FOUND", message: url.pathname });
    }),
  );
  const app = await createTestApp({
    plugins: [designer()],
    client: createWorkspaceClient({ host: workspaceUrl, token: "test-only" }),
    env: { DATABRICKS_JOB_ID: "10", DATABRICKS_APP_ID: "app-id", ...env },
  });
  t.onTestFinished(() => app.close());
  const appUrl = app.baseUrl;
  const call = (
    path,
    viewer = "alice",
    method = "GET",
    body,
    contentEncoding,
  ) =>
    fetch(`${appUrl}/api/designer${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-forwarded-user": viewer,
        "x-forwarded-email": `${viewer}@example.test`,
        ...(contentEncoding ? { "content-encoding": contentEncoding } : {}),
      },
      ...(body === undefined
        ? {}
        : {
            body:
              contentEncoding === "gzip"
                ? gzipSync(JSON.stringify(body))
                : contentEncoding === "deflate"
                  ? deflateSync(JSON.stringify(body))
                  : JSON.stringify(body),
          }),
    });
  return { state, call, app };
}

test("ordinary App runs stay within the submitting viewer without granting Job permissions", async (t) => {
  const { state, call } = await harness(t);
  const config = await (await call("/config")).json();
  assert.equal(config.runnable, true);
  assert.equal(config.manifest.runner, undefined);
  const submitted = await call("/run", "alice", "POST", {
    params: { choice: "B", hidden: "override", _lb_app_viewer: "bob" },
  });
  assert.equal(submitted.status, 200);
  const { jobRunId } = await submitted.json();
  assert.equal(state.submissions[0].job_parameters.hidden, "published default");
  const run = await (await call(`/run/${jobRunId}`)).json();
  assert.deepEqual(run.parameters, { choice: "B" });
  assert.equal((await call(`/run/${jobRunId}`, "bob")).status, 404);
  assert.equal((await call(`/run/${jobRunId}`, "bob", "DELETE")).status, 404);
  assert.equal((await call("/run", "", "POST", {})).status, 401);
  assert.equal((await call(`/run/${jobRunId}`, "alice", "DELETE")).status, 200);
  assert.deepEqual(state.cancellations, [Number(jobRunId)]);
  assert.deepEqual(
    state.requests.filter(({ path }) => path.includes("/permissions/")),
    [],
  );
});

test("submissions pause until runner code and every default match the manifest", async (t) => {
  const { state, call } = await harness(t);
  const notebook = state.job.settings.tasks[0].notebook_task;
  const published = structuredClone(notebook);
  for (const changed of [
    {
      ...published,
      notebook_path: `/Users/author/app/runner-${"b".repeat(64)}.designer.py`,
    },
    {
      ...published,
      base_parameters: { ...published.base_parameters, hidden: "new default" },
    },
    {
      ...published,
      base_parameters: { ...published.base_parameters, added: "new input" },
    },
  ]) {
    Object.assign(notebook, changed);
    const config = await (await call("/config")).json();
    assert.equal(config.runnable, false);
    assert.equal(config.notRunnableReason, "updating");
    const refused = await call("/run", "alice", "POST", {});
    assert.equal(refused.status, 409);
    assert.match((await refused.json()).error, /updating/);
  }
  assert.deepEqual(state.submissions, []);
  Object.assign(notebook, published);
  assert.equal((await call("/run", "alice", "POST", {})).status, 200);
});

test("compressed JSON submissions preserve parameters through the HTTP parser", async (t) => {
  const { state, call } = await harness(t);
  for (const encoding of ["gzip", "deflate"]) {
    const response = await call(
      "/run",
      "alice",
      "POST",
      { params: { choice: encoding } },
      encoding,
    );
    assert.equal(response.status, 200);
    const { jobRunId } = await response.json();
    const run = await (await call(`/run/${jobRunId}`)).json();
    assert.deepEqual(run.parameters, { choice: encoding });
  }
  assert.equal(state.runs.length, 2);
});

test("SDK retries reuse the submission token without starting a second run", async (t) => {
  const { state, call } = await harness(t);
  state.failAcceptedSubmission = true;
  const response = await call("/run", "alice", "POST", {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).jobRunId, "1001");
  const attempts = state.requests.filter(({ path }) =>
    path.endsWith("/jobs/run-now"),
  );
  assert.equal(attempts.length, 2);
  const token = attempts[0].body.idempotency_token;
  assert.equal(token, attempts[0].body.job_parameters._lb_app_submission_id);
  assert.equal(attempts[1].body.idempotency_token, token);
  assert.equal(state.runs.length, 1);
});

test("history preserves a continuation beyond 200 other viewers’ runs", async (t) => {
  const { state, call } = await harness(t);
  const response = await call("/run", "alice", "POST", {});
  const { jobRunId } = await response.json();
  const ownRun = state.runs[0];
  ownRun.state = { life_cycle_state: "TERMINATED", result_state: "SUCCESS" };
  state.runs.unshift(
    ...Array.from({ length: 200 }, (_, index) => ({
      ...ownRun,
      run_id: 2000 + index,
      start_time: ownRun.start_time + 200 - index,
      job_parameters: [{ name: "_lb_app_viewer", value: "another-viewer" }],
    })),
  );
  const first = await (await call("/runs")).json();
  assert.deepEqual(first.runs, []);
  assert.equal(first.hasMore, true);
  const older = await (
    await call(`/runs?cursor=${first.nextPageToken}`)
  ).json();
  assert.deepEqual(
    older.runs.map((run) => run.jobRunId),
    [jobRunId],
  );
  assert.equal(older.hasMore, false);
  const search = await (await call("/last-run")).json();
  assert.equal(search.status, "searching");
  const last = await (
    await call(`/last-run?cursor=${search.nextPageToken}`)
  ).json();
  assert.equal(last.status, "found");
  assert.equal(last.run.jobRunId, jobRunId);
});

test("configuration refresh invalidates incompatible manifests and stops new submissions", async (t) => {
  const { state, call } = await harness(t);
  assert.equal((await (await call("/config")).json()).runnable, true);
  state.manifest.version = 9;
  assert.deepEqual(await (await call("/config")).json(), {
    manifest: null,
    runnable: false,
    notRunnableReason: "noManifest",
  });
  assert.equal((await call("/run", "alice", "POST", {})).status, 409);
  assert.equal(state.submissions.length, 0);
});

test("private responses enforce the public App origin and expose only Designer routes", async (t) => {
  const { app, state } = await harness(t, {
    DATABRICKS_APP_URL: "https://report.example.test",
  });
  const response = await app.get("/api/designer/config", {
    headers: { origin: "https://report.example.test" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(
    response.headers.get("cross-origin-resource-policy"),
    "same-origin",
  );
  state.requests.length = 0;
  assert.equal(
    (
      await app.get("/api/designer/config", {
        headers: { origin: "https://other.example.test" },
      })
    ).status,
    403,
  );
  assert.equal(state.requests.length, 0);
  assert.equal((await app.get("/api/files/list")).status, 404);
  assert.equal((await app.post("/api/jobs/default/run")).status, 404);
});

test("cached completed results still require current viewer and Job ownership", async (t) => {
  const { state, call } = await harness(t);
  const { jobRunId } = await (await call("/run", "alice", "POST", {})).json();
  const run = state.runs[0];
  run.state = { life_cycle_state: "TERMINATED", result_state: "SUCCESS" };
  run.tasks = [{ run_id: 11 }];
  const model = {
    commands: [
      {
        command: 'display(ctx["source.data"])',
        results: {
          type: "table",
          schema: [{ name: "value", type: '"long"' }],
          data: [[42]],
          overflow: false,
        },
      },
    ],
  };
  state.exportedHtml = `__DATABRICKS_NOTEBOOK_MODEL = '${Buffer.from(encodeURIComponent(JSON.stringify(model))).toString("base64")}'`;
  const first = await (await call(`/run/${jobRunId}`)).json();
  assert.equal(first.result.outputs[0].outcome.payload.rows[0].value, 42);
  assert.deepEqual(await (await call(`/run/${jobRunId}`)).json(), first);
  assert.equal((await call(`/run/${jobRunId}`, "bob")).status, 404);
  run.job_id = 20;
  assert.equal((await call(`/run/${jobRunId}`)).status, 404);
  assert.equal(
    state.requests.filter(({ path }) => path.endsWith("/jobs/runs/export"))
      .length,
    1,
  );
});

test("a new plugin instance discovers its own manifest after shutdown", async (t) => {
  const first = await harness(t);
  first.state.manifest.appName = "First App";
  assert.equal(
    (await (await first.call("/config")).json()).manifest.appName,
    "First App",
  );
  await first.app.close();
  const second = await harness(t);
  assert.equal(
    (await (await second.call("/config")).json()).manifest.appName,
    "Report",
  );
});
