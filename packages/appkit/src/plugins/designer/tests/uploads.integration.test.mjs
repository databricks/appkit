import assert from "node:assert/strict";

import { test } from "vitest";

import { createTestApp } from "../../../testing";
import { ApiError } from "../../../workspace-client";
import { designer } from "../plugin";

async function harness(t) {
  const revision = "a".repeat(64);
  const defaults = { _lb_runner_revision: revision, path: "" };
  const manifest = {
    version: 8,
    appName: "Upload report",
    runner: { revision, parameters: defaults },
    storage: {
      volume: "main.apps.files",
      path: "/Volumes/main/apps/files/designer_apps/app1",
      maxUploadFileSizeBytes: 1024,
    },
    parameters: [
      {
        name: "path",
        label: "File",
        type: "file",
        defaultValue: "",
        fileFormats: ["csv"],
      },
    ],
    blocks: [{ type: "output", id: "out", nodeId: "source", port: "data" }],
  };
  const files = new Map();
  const stored = (path) => {
    const value = files.get(path);
    if (!value) throw new ApiError("Not found", "NOT_FOUND", 404);
    return value;
  };
  const put = async (path, body, overwrite) => {
    assert.equal(overwrite, false);
    assert.equal(files.has(path), false);
    files.set(path, Buffer.from(await new Response(body).arrayBuffer()));
  };
  const submissions = [];
  // Replace only Databricks services; AppKit routes, SDK adapter, and streams are real.
  const app = await createTestApp({
    plugins: [designer()],
    env: { DATABRICKS_JOB_ID: "10", DATABRICKS_APP_ID: "app-id" },
    responses: {
      request: async ({ method, path, query, body }) => {
        if (path.endsWith("/jobs/get"))
          return Response.json({
            settings: {
              tasks: [
                {
                  notebook_task: {
                    notebook_path: `/Users/author/app/runner-${revision}.designer.py`,
                    base_parameters: defaults,
                  },
                },
              ],
            },
          });
        if (path.endsWith("/workspace/export"))
          return Response.json({
            content: Buffer.from(JSON.stringify(manifest)).toString("base64"),
          });
        assert.ok(path.startsWith("/api/2.0/fs/files/Volumes/"));
        const filePath = decodeURIComponent(
          path.slice("/api/2.0/fs/files".length),
        );
        if (method === "HEAD")
          return new Response(null, {
            headers: { "content-length": String(stored(filePath).length) },
          });
        assert.equal(method, "PUT");
        await put(filePath, body, query.overwrite === "true");
        return new Response(null, { status: 204 });
      },
      "files.createDirectory": async () => {},
      "files.uploadFile": async ({ filePath, contents, overwrite }) =>
        put(filePath, contents, overwrite),
      "files.downloadFile": async ({ filePath }) => ({
        contents: new Response(stored(filePath)).body,
      }),
      "files.deleteFile": async ({ filePath }) => {
        files.delete(filePath);
      },
      "jobs.runNow": async (submission) => {
        submissions.push(submission);
        return { runId: 42 };
      },
    },
  });
  t.onTestFinished(() => app.close());
  const headers = {
    "x-forwarded-user": "alice",
    "x-forwarded-email": "alice@example.test",
  };
  const upload = (body) =>
    app.post("/api/designer/uploads/path", {
      body,
      headers: {
        ...headers,
        "content-type": "application/octet-stream",
        "x-file-name": "sales.csv",
      },
    });
  return { app, headers, upload, files, manifest, submissions };
}

test("streamed uploads can be downloaded and passed to runs through the plugin", async (t) => {
  const { app, headers, upload, files, manifest, submissions } =
    await harness(t);
  const before = Object.entries(process.env).filter(([key]) =>
    key.startsWith("DATABRICKS_VOLUME_"),
  );
  const response = await upload("price\n42\n");
  assert.equal(response.status, 201);
  const receipt = (await response.json()).upload;
  const path = `/api/designer/uploads/path/${encodeURIComponent(receipt.reference)}/download`;
  assert.equal(await (await app.get(path, { headers })).text(), "price\n42\n");
  assert.equal(
    (await app.get(path, { headers: { "x-forwarded-user": "bob" } })).status,
    404,
  );
  const run = await app.post("/api/designer/run", {
    headers,
    body: { params: { path: receipt.reference } },
  });
  assert.deepEqual(await run.json(), { jobRunId: "42" });
  assert.equal(
    files.get(submissions[0].jobParameters.path).toString(),
    "price\n42\n",
  );
  assert.ok(
    submissions[0].jobParameters.path.startsWith(
      manifest.storage.path + "/uploads/",
    ),
  );
  assert.deepEqual(
    Object.entries(process.env).filter(([key]) =>
      key.startsWith("DATABRICKS_VOLUME_"),
    ),
    before,
  );
  manifest.storage.path = "/Volumes/main/apps/files/designer_apps/app2";
  assert.equal((await app.get(path, { headers })).status, 404);
  assert.equal(
    (
      await app.post("/api/designer/run", {
        headers,
        body: { params: { path: receipt.reference } },
      })
    ).status,
    400,
  );
});

test("stream errors and invalid file formats do not leave a completed upload", async (t) => {
  const { app, headers, upload, files } = await harness(t);
  assert.equal((await upload("a".repeat(1025))).status, 413);
  assert.equal(files.size, 0);
  assert.equal(
    (
      await app.post("/api/designer/uploads/path", {
        body: "data",
        headers: {
          ...headers,
          "content-type": "application/octet-stream",
          "x-file-name": "report.xlsx",
        },
      })
    ).status,
    400,
  );
  assert.equal(files.size, 0);
});
