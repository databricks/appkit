import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { createApp, server } from "@databricks/appkit";
import express from "express";

const root = import.meta.dirname;
const statusFile = path.join(root, "client/src/design/status.json");

// One draft run at a time: a new prompt replaces the previous drafts (they share mock.ts).
let run: { id: string; running: boolean; error?: string } | undefined;

createApp({
  plugins: [server()],
  async onPluginsReady(appkit) {
    appkit.server.extend((app) => {
      app.post("/api/drafts", express.json(), (req, res) => {
        const { prompt, answers = "" } = req.body ?? {};
        if (typeof prompt !== "string" || !prompt.trim()) {
          res.status(400).json({ error: "prompt is required" });
          return;
        }
        if (run?.running) {
          res.status(409).json({ error: "a run is already in progress" });
          return;
        }
        const id = `r${Date.now().toString(36)}`;
        const current: NonNullable<typeof run> = { id, running: true };
        run = current;
        const child = spawn(
          process.execPath,
          [
            path.join(root, "scripts/draft.ts"),
            "--name",
            id,
            "--prompt",
            prompt,
            "--answers",
            String(answers),
          ],
          { cwd: root, stdio: ["ignore", "inherit", "pipe"] },
        );
        let stderr = "";
        child.stderr.on("data", (d) => {
          stderr = (stderr + d).slice(-2000);
          process.stderr.write(d);
        });
        child.on("exit", (code) => {
          current.running = false;
          if (code !== 0)
            current.error =
              stderr.trim().split("\n").slice(-6).join("\n") || `exit ${code}`;
        });
        res.json({ id });
      });

      app.get("/api/drafts", async (_req, res) => {
        const status = await readFile(statusFile, "utf8").then(
          JSON.parse,
          () => null,
        );
        // status.json from an earlier run is stale until this run's first write.
        const fresh = status?.results?.[1]?.name?.startsWith(run?.id ?? "\0")
          ? status
          : null;
        res.json({ run, status: run ? fresh : status });
      });
    });
  },
});
