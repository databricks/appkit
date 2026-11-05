// KIT-40 spike: a bare Vite dev server with the design plugin (from source), so the
// replay page runs without a Databricks login (AppKit's server() needs workspace auth).
//
// It also stands in for App Builder: POST /__spike/reset clears the drafts, then
// POST /__spike/replay/<app> replays
// drafts/recordings/<app>.json by appending each draft's chunks to
// client/src/design/.staging/<name>.tsx (and the mock's to .staging/mock.ts) at the
// recorded timing, batched every 100 ms, and writing the finished file to
// client/src/design/pages/<name>.tsx (mock.ts) when the recording says it type-checked.
import fs from "node:fs";
import path from "node:path";

import { createServer } from "vite";

import { designVitePlugin } from "../../packages/appkit/src/plugins/design/vite-plugin.ts";

type Recording = {
  app: string;
  streams: Record<
    string,
    { chunks: [number, string][]; final: string; finalAt: number }
  >;
};

const recordings = path.resolve("drafts/recordings");
const design = path.resolve("client/src/design");
const BATCH_MS = 100;
// Time for the replay page to get ready; the recording's t=0 is this far after the request.
const LEAD_MS = 1500;

function reset() {
  let deleted = 0;
  for (const dir of [".staging", "pages"]) {
    fs.mkdirSync(path.join(design, dir), { recursive: true });
    for (const f of fs.readdirSync(path.join(design, dir))) {
      fs.rmSync(path.join(design, dir, f));
      deleted++;
    }
  }
  if (fs.existsSync(path.join(design, "mock.ts"))) {
    fs.rmSync(path.join(design, "mock.ts"));
    deleted++;
  }
  return deleted;
}

function replay(rec: Recording) {
  const start = Date.now() + LEAD_MS;
  for (const [key, stream] of Object.entries(rec.streams)) {
    const mock = key === "mock.ts";
    const staging = path.join(
      design,
      ".staging",
      mock ? "mock.ts" : `${key}.tsx`,
    );
    const final = mock
      ? path.join(design, "mock.ts")
      : path.join(design, "pages", `${key}.tsx`);
    let next = 0;
    const tick = setInterval(() => {
      const now = Date.now() - start;
      let text = "";
      while (next < stream.chunks.length && stream.chunks[next][0] <= now)
        text += stream.chunks[next++][1];
      if (text) fs.appendFileSync(staging, text);
      if (now >= stream.finalAt) {
        clearInterval(tick);
        fs.writeFileSync(final, stream.final);
      }
    }, BATCH_MS);
  }
  return start;
}

const server = await createServer({
  configFile: "client/vite.config.ts",
  root: "client",
  plugins: [
    designVitePlugin(),
    {
      name: "spike-replay",
      configureServer(s) {
        s.middlewares.use((req, res, next) => {
          if (req.url === "/__spike/recordings") {
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify(
                fs
                  .readdirSync(recordings)
                  .filter((f) => f.endsWith(".json"))
                  .map((f) => f.slice(0, -5)),
              ),
            );
            return;
          }
          const m = /^\/__spike\/recordings\/([\w-]+)$/.exec(req.url ?? "");
          if (m) {
            res.setHeader("Content-Type", "application/json");
            res.end(
              fs.readFileSync(path.join(recordings, `${m[1]}.json`), "utf-8"),
            );
            return;
          }
          if (req.url === "/__spike/reset" && req.method === "POST") {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ deleted: reset() }));
            return;
          }
          const r = /^\/__spike\/replay\/([\w-]+)$/.exec(req.url ?? "");
          if (r && req.method === "POST") {
            const rec = JSON.parse(
              fs.readFileSync(path.join(recordings, `${r[1]}.json`), "utf-8"),
            ) as Recording;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ start: replay(rec) }));
            return;
          }
          next();
        });
      },
    },
  ],
  server: { port: Number(process.env.PORT ?? 8040), strictPort: true },
});
await server.listen();
server.printUrls();
console.log(
  `  replay: http://localhost:${server.config.server.port}/replay.html`,
);
