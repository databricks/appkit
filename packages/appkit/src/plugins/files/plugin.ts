import { Readable } from "node:stream";
import type express from "express";
import type { IAppRouter } from "shared";
import { getWorkspaceClient } from "../../context";
import { Plugin, toPlugin } from "../../plugin";
import { contentTypeFromPath } from "./helpers";
import { FilesClient } from "./lib";
import { filesManifest } from "./manifest";
import type { DownloadResponse, IFilesConfig } from "./types";

export class FilesPlugin extends Plugin {
  name = "files";

  static manifest = filesManifest;
  protected static description = "Files plugin for Databricks file operations";
  protected declare config: IFilesConfig;

  constructor(config: IFilesConfig) {
    super(config);
    this.config = config;
  }

  /**
   * Create a FilesClient scoped to the current execution context.
   * Must be called per-request so `asUser()` context is respected.
   */
  private getFilesClient(): FilesClient {
    const client = getWorkspaceClient();
    return new FilesClient({
      defaultVolume: this.config.defaultVolume,
      client,
    });
  }

  // --- Public methods (proxied by asUser) ---

  async list(directoryPath?: string) {
    return this.getFilesClient().list(directoryPath);
  }

  async read(filePath: string) {
    return this.getFilesClient().read(filePath);
  }

  async download(filePath: string): Promise<DownloadResponse> {
    return this.getFilesClient().download(filePath);
  }

  async exists(filePath: string) {
    return this.getFilesClient().exists(filePath);
  }

  async metadata(filePath: string) {
    return this.getFilesClient().metadata(filePath);
  }

  async upload(
    filePath: string,
    contents: ReadableStream | Buffer | string,
    options?: { overwrite?: boolean },
  ) {
    return this.getFilesClient().upload(filePath, contents, options);
  }

  async createDirectory(directoryPath: string) {
    return this.getFilesClient().createDirectory(directoryPath);
  }

  async delete(filePath: string) {
    return this.getFilesClient().delete(filePath);
  }

  async preview(filePath: string) {
    return this.getFilesClient().preview(filePath);
  }

  // --- Routes ---

  injectRoutes(router: IAppRouter) {
    this.route(router, {
      name: "root",
      method: "get",
      path: "/root",
      handler: async (_req: express.Request, res: express.Response) => {
        res.json({ root: this.config.defaultVolume ?? null });
      },
    });

    this.route(router, {
      name: "list",
      method: "get",
      path: "/list",
      handler: async (req: express.Request, res: express.Response) => {
        await this._handleList(req, res);
      },
    });

    this.route(router, {
      name: "read",
      method: "get",
      path: "/read",
      handler: async (req: express.Request, res: express.Response) => {
        await this._handleRead(req, res);
      },
    });

    this.route(router, {
      name: "download",
      method: "get",
      path: "/download",
      handler: async (req: express.Request, res: express.Response) => {
        await this._handleDownload(req, res);
      },
    });

    this.route(router, {
      name: "raw",
      method: "get",
      path: "/raw",
      handler: async (req: express.Request, res: express.Response) => {
        await this._handleRaw(req, res);
      },
    });

    this.route(router, {
      name: "exists",
      method: "get",
      path: "/exists",
      handler: async (req: express.Request, res: express.Response) => {
        await this._handleExists(req, res);
      },
    });

    this.route(router, {
      name: "metadata",
      method: "get",
      path: "/metadata",
      handler: async (req: express.Request, res: express.Response) => {
        await this._handleMetadata(req, res);
      },
    });

    this.route(router, {
      name: "preview",
      method: "get",
      path: "/preview",
      handler: async (req: express.Request, res: express.Response) => {
        await this._handlePreview(req, res);
      },
    });

    this.route(router, {
      name: "upload",
      method: "post",
      path: "/upload",
      handler: async (req: express.Request, res: express.Response) => {
        await this._handleUpload(req, res);
      },
    });

    this.route(router, {
      name: "mkdir",
      method: "post",
      path: "/mkdir",
      handler: async (req: express.Request, res: express.Response) => {
        await this._handleMkdir(req, res);
      },
    });

    this.route(router, {
      name: "delete",
      method: "post",
      path: "/delete",
      handler: async (req: express.Request, res: express.Response) => {
        await this._handleDelete(req, res);
      },
    });
  }

  // --- Private route handlers ---

  private async _handleList(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    try {
      const path = req.query.path as string | undefined;
      const entries = await this.asUser(req).list(path);
      res.json(entries);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "List failed",
        plugin: this.name,
      });
    }
  }

  private async _handleRead(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    try {
      const path = req.query.path as string;
      if (!path) {
        res.status(400).json({ error: "path is required", plugin: this.name });
        return;
      }
      const content = await this.asUser(req).read(path);
      res.type("text/plain").send(content);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Read failed",
        plugin: this.name,
      });
    }
  }

  private async _handleDownload(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    try {
      const path = req.query.path as string;
      if (!path) {
        res.status(400).json({ error: "path is required", plugin: this.name });
        return;
      }
      const response = await this.asUser(req).download(path);
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
      res.status(500).json({
        error: error instanceof Error ? error.message : "Download failed",
        plugin: this.name,
      });
    }
  }

  private async _handleRaw(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    try {
      const path = req.query.path as string;
      if (!path) {
        res.status(400).json({ error: "path is required", plugin: this.name });
        return;
      }
      const response = await this.asUser(req).download(path);
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
      res.status(500).json({
        error: error instanceof Error ? error.message : "Raw fetch failed",
        plugin: this.name,
      });
    }
  }

  private async _handleExists(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    try {
      const path = req.query.path as string;
      if (!path) {
        res.status(400).json({ error: "path is required", plugin: this.name });
        return;
      }
      const exists = await this.asUser(req).exists(path);
      res.json({ exists });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Exists check failed",
        plugin: this.name,
      });
    }
  }

  private async _handleMetadata(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    try {
      const path = req.query.path as string;
      if (!path) {
        res.status(400).json({ error: "path is required", plugin: this.name });
        return;
      }
      const metadata = await this.asUser(req).metadata(path);
      res.json(metadata);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Metadata fetch failed",
        plugin: this.name,
      });
    }
  }

  private async _handlePreview(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    try {
      const path = req.query.path as string;
      if (!path) {
        res.status(400).json({ error: "path is required", plugin: this.name });
        return;
      }
      const preview = await this.asUser(req).preview(path);
      res.json(preview);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Preview failed",
        plugin: this.name,
      });
    }
  }

  private async _handleUpload(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    try {
      const path = req.query.path as string;
      if (!path) {
        res.status(400).json({ error: "path is required", plugin: this.name });
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", async () => {
        try {
          const body = Buffer.concat(chunks);
          await this.asUser(req).upload(path, body);
          res.json({ success: true });
        } catch (error) {
          res.status(500).json({
            error: error instanceof Error ? error.message : "Upload failed",
            plugin: this.name,
          });
        }
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Upload failed",
        plugin: this.name,
      });
    }
  }

  private async _handleMkdir(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    try {
      const dirPath = req.body?.path as string;
      if (!dirPath) {
        res.status(400).json({ error: "path is required", plugin: this.name });
        return;
      }
      await this.asUser(req).createDirectory(dirPath);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error ? error.message : "Create directory failed",
        plugin: this.name,
      });
    }
  }

  private async _handleDelete(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    try {
      const path = req.query.path as string;
      if (!path) {
        res.status(400).json({ error: "path is required", plugin: this.name });
        return;
      }
      await this.asUser(req).delete(path);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Delete failed",
        plugin: this.name,
      });
    }
  }

  async shutdown(): Promise<void> {
    this.streamManager.abortAll();
  }

  exports() {
    return {
      list: this.list,
      read: this.read,
      download: this.download,
      exists: this.exists,
      metadata: this.metadata,
      upload: this.upload,
      createDirectory: this.createDirectory,
      delete: this.delete,
      preview: this.preview,
    };
  }
}

/**
 * @internal
 */
export const files = toPlugin<typeof FilesPlugin, IFilesConfig, "files">(
  FilesPlugin,
  "files",
);
