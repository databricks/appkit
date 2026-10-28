import type { FilesConnector } from "../../../connectors/files";
import { ApiError, type WorkspaceClient } from "../../../workspace-client";
import type { AppStorage } from "../shared/storageConfig";
import {
  UPLOAD_UNAVAILABLE,
  UPLOAD_UNAVAILABLE_MESSAGE,
} from "../shared/storageConfig";
import { uploadStoragePath } from "../shared/storageConfig";
import { UploadError, type UploadStore } from "./fileUploads";
import { parseStorageFileSize } from "./storageVolume";

export function createUploadStore(
  client: WorkspaceClient,
  connector: FilesConnector,
  config: AppStorage | undefined,
): UploadStore {
  const access = async <T>(
    path: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    try {
      if (!config)
        throw new UploadError(409, "File uploads are not configured.");
      if (!path.startsWith(`${uploadStoragePath(config)}/`))
        throw new Error("Invalid upload storage destination.");
      return await operation();
    } catch (error) {
      if (error instanceof UploadError) throw error;
      const missing = error instanceof ApiError && error.statusCode === 404;
      throw new UploadError(
        missing ? 404 : 502,
        missing
          ? UPLOAD_UNAVAILABLE_MESSAGE
          : "Could not access upload storage. Check the app volume resource and permissions.",
        { cause: error, ...(missing ? { code: UPLOAD_UNAVAILABLE } : {}) },
      );
    }
  };
  return {
    mkdir: (path) =>
      access(path, () => connector.createDirectory(client, path)),
    put: (path, bytes) =>
      access(path, () =>
        connector.upload(client, path, Buffer.from(bytes), {
          overwrite: false,
        }),
      ),
    putStream: (path, stream) =>
      access(path, () =>
        connector.upload(client, path, stream, { overwrite: false }),
      ),
    read: (path) =>
      access(path, async () => {
        const contents = await connector.read(client, path, {
          maxSize: 16 * 1024,
        });
        try {
          const record: unknown = JSON.parse(contents);
          return record;
        } catch {
          throw new UploadError(409, "The upload record is unreadable.");
        }
      }),
    download: (path) =>
      access(path, async () => {
        const result = await connector.download(client, path);
        if (!result.contents)
          throw new UploadError(
            502,
            "The uploaded file has no readable contents.",
          );
        return result.contents;
      }),
    size: (path) =>
      access(path, async () => {
        const metadata = await connector.metadata(client, path);
        return parseStorageFileSize(metadata.contentLength);
      }),
    delete: (path) => access(path, () => connector.delete(client, path)),
  };
}
