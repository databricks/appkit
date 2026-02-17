import { ApiError, WorkspaceClient } from "@databricks/sdk-experimental";
import { contentTypeFromPath } from "./helpers";
import type {
  DirectoryEntry,
  DownloadResponse,
  FileMetadata,
  FilePreview,
} from "./types";

export class FilesClient {
  private client: WorkspaceClient;
  private defaultVolume: string | undefined;

  constructor({
    defaultVolume,
    client,
  }: {
    defaultVolume?: string;
    client?: WorkspaceClient;
  }) {
    this.client = client ?? new WorkspaceClient({});
    if (defaultVolume) {
      this.defaultVolume = defaultVolume;
    }
  }

  private resolvePath(filePath: string): string {
    if (filePath.startsWith("/")) {
      return filePath;
    }
    if (!this.defaultVolume) {
      throw new Error(
        "Cannot resolve relative path: no default volume set. Use an absolute path or set a default volume.",
      );
    }
    return `${this.defaultVolume}/${filePath}`;
  }

  volume(volumePath: string): FilesClient {
    return new FilesClient({ defaultVolume: volumePath, client: this.client });
  }

  async list(directoryPath?: string): Promise<DirectoryEntry[]> {
    const resolvedPath = directoryPath
      ? this.resolvePath(directoryPath)
      : this.defaultVolume;
    if (!resolvedPath) {
      throw new Error("No directory path provided and no default volume set.");
    }
    const entries: DirectoryEntry[] = [];
    for await (const entry of this.client.files.listDirectoryContents({
      directory_path: resolvedPath,
    })) {
      entries.push(entry);
    }
    return entries;
  }

  async read(filePath: string): Promise<string> {
    const response = await this.download(filePath);
    if (!response.contents) {
      return "";
    }
    const reader = response.contents.getReader();
    const decoder = new TextDecoder();
    let result = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();
    return result;
  }

  async download(filePath: string): Promise<DownloadResponse> {
    return this.client.files.download({
      file_path: this.resolvePath(filePath),
    });
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await this.metadata(filePath);
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 404) {
        return false;
      }
      throw error;
    }
  }

  async metadata(filePath: string): Promise<FileMetadata> {
    const response = await this.client.files.getMetadata({
      file_path: this.resolvePath(filePath),
    });
    return {
      contentLength: response["content-length"],
      contentType: contentTypeFromPath(filePath, response["content-type"]),
      lastModified: response["last-modified"],
    };
  }

  async upload(
    filePath: string,
    contents: ReadableStream | Buffer | string,
    options?: { overwrite?: boolean },
  ): Promise<void> {
    // Workaround: The SDK's files.upload() has two bugs:
    // 1. It ignores the `contents` field (sets body to undefined)
    // 2. apiClient.request() checks `instanceof` against its own ReadableStream
    //    subclass, so standard ReadableStream instances get JSON.stringified to "{}"
    // Bypass both by calling the REST API directly with SDK-provided auth.
    let body: Buffer | string;
    if (typeof contents === "string") {
      body = contents;
    } else if (Buffer.isBuffer(contents)) {
      body = contents;
    } else {
      // ReadableStream → Buffer
      const reader = (contents as ReadableStream<Uint8Array>).getReader();
      const chunks: Uint8Array[] = [];
      let result = await reader.read();
      while (!result.done) {
        chunks.push(result.value);
        result = await reader.read();
      }
      body = Buffer.concat(chunks);
    }

    const resolvedPath = this.resolvePath(filePath);
    const overwrite = options?.overwrite ?? true;
    const url = new URL(
      `/api/2.0/fs/files${resolvedPath}`,
      this.client.config.host,
    );
    url.searchParams.set("overwrite", String(overwrite));

    const headers = new Headers({ "Content-Type": "application/octet-stream" });
    await this.client.config.authenticate(headers);

    const res = await fetch(url.toString(), {
      method: "PUT",
      headers,
      body,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Upload failed (${res.status}): ${text}`);
    }
  }

  async delete(filePath: string): Promise<void> {
    await this.client.files.delete({
      file_path: this.resolvePath(filePath),
    });
  }

  async preview(filePath: string): Promise<FilePreview> {
    const meta = await this.metadata(filePath);
    const isText =
      meta.contentType?.startsWith("text/") ||
      meta.contentType === "application/json" ||
      meta.contentType === "application/xml" ||
      false;
    const isImage = meta.contentType?.startsWith("image/") || false;

    if (!isText) {
      return { ...meta, textPreview: null, isText: false, isImage };
    }

    const response = await this.client.files.download({
      file_path: this.resolvePath(filePath),
    });
    if (!response.contents) {
      return { ...meta, textPreview: "", isText: true, isImage: false };
    }

    const reader = response.contents.getReader();
    const decoder = new TextDecoder();
    let preview = "";
    const maxBytes = 1024;

    while (preview.length < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      preview += decoder.decode(value, { stream: true });
    }
    preview += decoder.decode();
    await reader.cancel();

    if (preview.length > maxBytes) {
      preview = preview.slice(0, maxBytes);
    }

    return { ...meta, textPreview: preview, isText: true, isImage: false };
  }
}
