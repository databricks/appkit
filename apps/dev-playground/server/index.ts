import "reflect-metadata";
import { Readable } from "node:stream";
import {
  analytics,
  contentTypeFromPath,
  createApp,
  files,
  server,
} from "@databricks/appkit";
import { WorkspaceClient } from "@databricks/sdk-experimental";
import { lakebaseExamples } from "./lakebase-examples-plugin";
import { reconnect } from "./reconnect-plugin";
import { telemetryExamples } from "./telemetry-example-plugin";

function createMockClient() {
  const client = new WorkspaceClient({
    host: "http://localhost",
    token: "e2e",
    authType: "pat",
  });
  client.currentUser.me = async () => ({ id: "e2e-test-user" });
  return client;
}

createApp({
  plugins: [
    server({ autoStart: false }),
    reconnect(),
    telemetryExamples(),
    analytics({}),
    lakebaseExamples(),
    files({ defaultVolume: process.env.DATABRICKS_DEFAULT_VOLUME }),
  ],
  ...(process.env.APPKIT_E2E_TEST && { client: createMockClient() }),
}).then((appkit) => {
  appkit.server
    .extend((app) => {
      app.get("/sp", (_req, res) => {
        appkit.analytics
          .query("SELECT * FROM samples.nyctaxi.trips;")
          .then((result) => {
            console.log(result[0]);
            res.json(result);
          })
          .catch((error) => {
            console.error("Error:", error);
            res.status(500).json({
              error: error.message,
              errorCode: error.errorCode,
              statusCode: error.statusCode,
            });
          });
      });

      app.get("/obo", (req, res) => {
        appkit.analytics
          .asUser(req)
          .query("SELECT * FROM samples.nyctaxi.trips;")
          .then((result) => {
            console.log(result[0]);
            res.json(result);
          })
          .catch((error) => {
            console.error("OBO Error:", error);
            res.status(500).json({
              error: error.message,
              errorCode: error.errorCode,
              statusCode: error.statusCode,
            });
          });
      });

      // --- Files routes ---

      app.get("/api/files/root", (_req, res) => {
        res.json({
          root: process.env.DATABRICKS_DEFAULT_VOLUME ?? null,
        });
      });

      app.get("/api/files/list", async (req, res) => {
        try {
          const path = req.query.path as string | undefined;
          const entries = await appkit.files.asUser(req).list(path);
          res.json(entries);
        } catch (error) {
          console.error("Files list error:", error);
          res.status(500).json({
            error: error instanceof Error ? error.message : "List failed",
          });
        }
      });

      app.get("/api/files/read", async (req, res) => {
        try {
          const path = req.query.path as string;
          if (!path) {
            res.status(400).json({ error: "path is required" });
            return;
          }
          const content = await appkit.files.asUser(req).read(path);
          res.type("text/plain").send(content);
        } catch (error) {
          console.error("Files read error:", error);
          res.status(500).json({
            error: error instanceof Error ? error.message : "Read failed",
          });
        }
      });

      app.get("/api/files/download", async (req, res) => {
        try {
          const path = req.query.path as string;
          if (!path) {
            res.status(400).json({ error: "path is required" });
            return;
          }
          const response = await appkit.files.asUser(req).download(path);
          const fileName = path.split("/").pop() ?? "download";
          res.setHeader(
            "Content-Disposition",
            `attachment; filename="${fileName}"`,
          );
          res.setHeader(
            "Content-Type",
            contentTypeFromPath(path) ?? "application/octet-stream",
          );
          if (response.contents) {
            const nodeStream = Readable.fromWeb(
              response.contents as import("node:stream/web").ReadableStream,
            );
            nodeStream.pipe(res);
          } else {
            res.end();
          }
        } catch (error) {
          console.error("Files download error:", error);
          res.status(500).json({
            error: error instanceof Error ? error.message : "Download failed",
          });
        }
      });

      app.get("/api/files/raw", async (req, res) => {
        try {
          const path = req.query.path as string;
          if (!path) {
            res.status(400).json({ error: "path is required" });
            return;
          }
          const response = await appkit.files.asUser(req).download(path);
          res.setHeader(
            "Content-Type",
            contentTypeFromPath(path) ?? "application/octet-stream",
          );
          if (response.contents) {
            const nodeStream = Readable.fromWeb(
              response.contents as import("node:stream/web").ReadableStream,
            );
            nodeStream.pipe(res);
          } else {
            res.end();
          }
        } catch (error) {
          console.error("Files raw error:", error);
          res.status(500).json({
            error: error instanceof Error ? error.message : "Raw fetch failed",
          });
        }
      });

      app.get("/api/files/exists", async (req, res) => {
        try {
          const path = req.query.path as string;
          if (!path) {
            res.status(400).json({ error: "path is required" });
            return;
          }
          const exists = await appkit.files.asUser(req).exists(path);
          res.json({ exists });
        } catch (error) {
          console.error("Files exists error:", error);
          res.status(500).json({
            error:
              error instanceof Error ? error.message : "Exists check failed",
          });
        }
      });

      app.get("/api/files/metadata", async (req, res) => {
        try {
          const path = req.query.path as string;
          if (!path) {
            res.status(400).json({ error: "path is required" });
            return;
          }
          const metadata = await appkit.files.asUser(req).metadata(path);
          res.json(metadata);
        } catch (error) {
          console.error("Files metadata error:", error);
          res.status(500).json({
            error:
              error instanceof Error ? error.message : "Metadata fetch failed",
          });
        }
      });

      app.post("/api/files/upload", async (req, res) => {
        try {
          const path = req.query.path as string;
          if (!path) {
            res.status(400).json({ error: "path is required" });
            return;
          }
          const chunks: Buffer[] = [];
          req.on("data", (chunk: Buffer) => chunks.push(chunk));
          req.on("end", async () => {
            try {
              const body = Buffer.concat(chunks);
              await appkit.files.asUser(req).upload(path, body);
              res.json({ success: true });
            } catch (error) {
              console.error("Files upload error:", error);
              res.status(500).json({
                error: error instanceof Error ? error.message : "Upload failed",
              });
            }
          });
        } catch (error) {
          console.error("Files upload error:", error);
          res.status(500).json({
            error: error instanceof Error ? error.message : "Upload failed",
          });
        }
      });

      app.post("/api/files/mkdir", async (req, res) => {
        try {
          const dirPath = req.body?.path as string;
          if (!dirPath) {
            res.status(400).json({ error: "path is required" });
            return;
          }
          await appkit.files.asUser(req).createDirectory(dirPath);
          res.json({ success: true });
        } catch (error) {
          console.error("Files mkdir error:", error);
          res.status(500).json({
            error:
              error instanceof Error
                ? error.message
                : "Create directory failed",
          });
        }
      });

      app.post("/api/files/delete", async (req, res) => {
        try {
          const path = req.query.path as string;
          if (!path) {
            res.status(400).json({ error: "path is required" });
            return;
          }
          await appkit.files.asUser(req).delete(path);
          res.json({ success: true });
        } catch (error) {
          console.error("Files delete error:", error);
          res.status(500).json({
            error: error instanceof Error ? error.message : "Delete failed",
          });
        }
      });

      app.get("/api/files/preview", async (req, res) => {
        try {
          const path = req.query.path as string;
          if (!path) {
            res.status(400).json({ error: "path is required" });
            return;
          }
          const preview = await appkit.files.asUser(req).preview(path);
          res.json(preview);
        } catch (error) {
          console.error("Files preview error:", error);
          res.status(500).json({
            error: error instanceof Error ? error.message : "Preview failed",
          });
        }
      });
    })
    .start();
});
