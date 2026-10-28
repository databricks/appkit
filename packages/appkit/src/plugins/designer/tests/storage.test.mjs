import assert from "node:assert/strict";

import { afterAll, beforeAll, test } from "vitest";

import { FilesConnector } from "../../../connectors/files";
import { createTestApp } from "../../../testing";
import { ApiError } from "../../../workspace-client";
import { createOutputFileStore } from "../server/outputFileStore";
import { createUploadStore } from "../server/uploadStore";
let app, appKitUploadStore, appKitOutputFileStore;
const contents = new Map();
const directories = new Set();
const config = {
  volume: "main.default.designer_app1",
  path: "/Volumes/main/default/designer_app1/designer_apps/app1",
  maxUploadFileSizeBytes: 5 * 1024 * 1024 * 1024,
};
let cancelledReads = 0;

function stored(path) {
  const bytes = contents.get(path);
  if (!bytes) throw new ApiError("File missing", "NOT_FOUND", 404);
  return bytes;
}

beforeAll(async () => {
  // Exercise the real Files connector, replacing only the remote workspace boundary.
  const upload = async (path, bytes, overwrite) => {
    assert.equal(overwrite, false);
    if (contents.has(path))
      throw new ApiError("Already exists", "ALREADY_EXISTS", 409);
    contents.set(
      path,
      bytes instanceof ReadableStream
        ? Buffer.from(await new Response(bytes).arrayBuffer())
        : Buffer.from(bytes),
    );
  };
  app = await createTestApp({
    plugins: [],
    server: false,
    client: {
      getHost: async () => "https://workspace.invalid",
      currentUser: { me: async () => ({ id: "app-service-principal" }) },
      request: async ({ method, path, query, body }) => {
        assert.ok(path.startsWith("/api/2.0/fs/files/Volumes/"));
        const filePath = decodeURIComponent(
          path.slice("/api/2.0/fs/files".length),
        );
        if (method === "HEAD") {
          return new Response(null, {
            headers: { "content-length": String(stored(filePath).length) },
          });
        }
        assert.equal(method, "PUT");
        await upload(filePath, body, query.overwrite === "true");
        return new Response(null, { status: 204 });
      },
      files: {
        createDirectory: async ({ directoryPath }) => {
          directories.add(directoryPath);
        },
        downloadFile: async ({ filePath }) => ({
          contents: new ReadableStream(
            {
              start(controller) {
                controller.enqueue(stored(filePath));
              },
              pull(controller) {
                controller.close();
              },
              cancel() {
                cancelledReads += 1;
              },
            },
            { highWaterMark: 0 },
          ),
        }),
        uploadFile: async ({ filePath, contents: bytes, overwrite }) =>
          upload(filePath, bytes, overwrite),
        listDirectoryContentsIter: async function* ({ directoryPath }) {
          const prefix = `${directoryPath}/`;
          for (const path of [...directories, ...contents.keys()]) {
            if (
              path.startsWith(prefix) &&
              !path.slice(prefix.length).includes("/")
            )
              yield {
                name: path.slice(prefix.length),
                isDirectory: directories.has(path),
              };
          }
        },
        deleteFile: async ({ filePath }) => {
          contents.delete(filePath);
        },
      },
    },
  });
  const connector = new FilesConnector({});
  appKitUploadStore = (config) =>
    createUploadStore(app.client, connector, config);
  appKitOutputFileStore = (volume) =>
    createOutputFileStore(app.client, connector, volume);
});

afterAll(() => app.close());

test("native output Files store reads exact original bytes repeatedly across separate volumes", async () => {
  await Promise.all(
    ["main.default.output_one", "main.default.output_two"].map(
      async (volume) => {
        const store = appKitOutputFileStore(volume);
        const root = `/Volumes/${volume.replaceAll(".", "/")}`;
        for (const name of [
          "result.csv",
          "multi sheet.xlsx",
          "データ.json",
          "data #1?100%.csv",
        ]) {
          const path = `${root}/reports/${name}`;
          assert.equal(await store.size(path), undefined);
          contents.set(path, Buffer.from("original bytes"));
          assert.equal(await store.size(path), 14);
          assert.equal(
            await new Response(await store.download(path)).text(),
            "original bytes",
          );
          assert.equal(
            await new Response(await store.download(path)).text(),
            "original bytes",
          );
          assert.equal(contents.get(path).toString(), "original bytes");
        }
        for (const path of [
          "/Volumes/main/default/other/report.csv",
          `${root}/../other/report.csv`,
          `${root}/code.py`,
        ])
          await assert.rejects(store.download(path));
        assert.deepEqual(Object.keys(store).sort(), ["download", "size"]);
      },
    ),
  );
});

test("uses the Files connector for immutable storage, downloads, bounded records, metadata and deletion", async () => {
  const store = appKitUploadStore(config);
  const folder = `${config.path}/uploads/viewer/parameter`;
  await store.mkdir(folder);
  await store.mkdir(`${folder}/child`);
  for (const filename of [
    "data.csv",
    "data.json",
    "data #1?100%.csv.gz",
    "carmax_car_prices copy (1).xlsx",
    "データ.xlsx",
  ]) {
    const path = `${folder}/${filename}`;
    const bytes = Buffer.from(JSON.stringify({ filename }));
    await store.put(path, bytes);
    assert.deepEqual(contents.get(path), bytes);
    assert.equal(await store.size(path), bytes.length);
    assert.deepEqual(await store.read(path), { filename });
    assert.deepEqual(
      Buffer.from(await new Response(await store.download(path)).arrayBuffer()),
      bytes,
    );
    await assert.rejects(store.put(path, Buffer.from("replacement")), {
      status: 502,
    });
    assert.deepEqual(contents.get(path), bytes);
  }
  const streamedPath = `${folder}/streamed.csv`;
  await store.putStream(
    streamedPath,
    new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from("streamed"));
        controller.close();
      },
    }),
  );
  assert.equal(contents.get(streamedPath).toString(), "streamed");
  await store.delete(`${folder}/data.csv`);
  await assert.rejects(store.read(`${folder}/data.csv`), { status: 404 });
  await assert.rejects(store.download(`${folder}/data.csv`), { status: 404 });
});

test("uploads and native output reads can share one physical volume without sharing handle policies", async () => {
  const uploadStore = appKitUploadStore(config);
  const outputStore = appKitOutputFileStore(config.volume);
  const outputPath =
    "/Volumes/main/default/designer_app1/reports/finished.xlsx";
  const uploadPath = `${config.path}/uploads/viewer/parameter/incoming.csv`;
  contents.set(outputPath, Buffer.from("original workbook"));
  await Promise.all([
    uploadStore.put(uploadPath, Buffer.from("new upload")),
    outputStore.size(outputPath).then((size) => assert.equal(size, 17)),
  ]);
  assert.equal(
    await new Response(await outputStore.download(outputPath)).text(),
    "original workbook",
  );
  await assert.rejects(uploadStore.read(outputPath), { status: 502 });
  await assert.rejects(uploadStore.download(outputPath), { status: 502 });
  assert.equal(await uploadStore.size(uploadPath), 10);
});

test("keeps oversized and malformed completion records unreadable", async () => {
  const store = appKitUploadStore(config);
  const path = `${config.path}/uploads/viewer/oversized.json`;
  contents.set(path, Buffer.alloc(16 * 1024 + 1));
  await assert.rejects(store.read(path), { status: 502 });
  assert.equal(cancelledReads, 1);
  contents.set(path, Buffer.from("not JSON"));
  await assert.rejects(store.read(path), { status: 409 });
});

test("limits plugin access to the uploads subtree of the configured app storage", async () => {
  const store = appKitUploadStore(config);
  await assert.rejects(
    store.put(
      "/Volumes/main/default/uploads/other-app/data.csv",
      Buffer.from("data"),
    ),
    {
      status: 502,
    },
  );
  for (const path of [
    `${config.path}/exports/results.xlsx`,
    `${config.path}/uploads_other/data.csv`,
  ]) {
    const bytes = Buffer.from("reserved");
    contents.set(path, bytes);
    await assert.rejects(store.read(path), { status: 502 });
    await assert.rejects(store.download(path), { status: 502 });
    await assert.rejects(store.put(path, Buffer.from("replacement")), {
      status: 502,
    });
    await assert.rejects(store.delete(path), { status: 502 });
    assert.deepEqual(contents.get(path), bytes);
  }
  await assert.rejects(
    appKitUploadStore(undefined).read(`${config.path}/file`),
    { status: 409 },
  );
});

test("switches volumes in one process while overlapping requests keep their own storage policies", async () => {
  const next = {
    ...config,
    volume: "main.default.designer_app2",
    path: "/Volumes/main/default/designer_app2/designer_apps/app1",
  };
  const before = appKitUploadStore(config);
  const after = appKitUploadStore(next);
  const beforePath = `${config.path}/uploads/viewer/parameter/old.csv`;
  const afterPath = `${next.path}/uploads/viewer/parameter/new.csv`;
  await Promise.all([
    before.put(beforePath, Buffer.from("old file")),
    after.put(afterPath, Buffer.from("new file")),
  ]);
  assert.equal(await before.size(beforePath), 8);
  assert.equal(await after.size(afterPath), 8);
  await assert.rejects(after.read(beforePath), { status: 502 });
  await assert.rejects(before.read(afterPath), { status: 502 });
  await appKitUploadStore(config).put(
    `${config.path}/uploads/viewer/parameter/back.csv`,
    Buffer.from("fresh"),
  );
  assert.equal(contents.get(beforePath).toString(), "old file");
  assert.equal(contents.get(afterPath).toString(), "new file");
});

test("allows republishing a different app root without changing the volume or sharing plugin policies", async () => {
  const previous = { ...config, path: `${config.path}_previous` };
  const previousStore = appKitUploadStore(previous);
  const store = appKitUploadStore(config);
  const beforePath = `${previous.path}/uploads/viewer/parameter/before.csv`;
  const afterPath = `${config.path}/uploads/viewer/parameter/after.csv`;

  await previousStore.put(beforePath, Buffer.from("before"));
  await store.put(afterPath, Buffer.from("after"));
  assert.equal(contents.get(beforePath).toString(), "before");
  assert.equal(contents.get(afterPath).toString(), "after");

  // In-flight requests keep their own scope even after another request reads the new manifest.
  await assert.rejects(previousStore.read(afterPath), { status: 502 });
  await Promise.all([
    previousStore.put(
      `${previous.path}/uploads/viewer/concurrent.csv`,
      Buffer.from("previous scope"),
    ),
    store.put(
      `${config.path}/uploads/viewer/concurrent.csv`,
      Buffer.from("current scope"),
    ),
  ]);
  assert.equal(
    contents.get(`${previous.path}/uploads/viewer/concurrent.csv`).toString(),
    "previous scope",
  );
  assert.equal(
    contents.get(`${config.path}/uploads/viewer/concurrent.csv`).toString(),
    "current scope",
  );
});
