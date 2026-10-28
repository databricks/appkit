import type { FilesConnector } from "../../../connectors/files";
import { ApiError, type WorkspaceClient } from "../../../workspace-client";
import { isOutputFilePath } from "../shared/fileOutputs";
import { parseStorageFileSize } from "./storageVolume";

export interface OutputFileStore {
  size(path: string): Promise<number | undefined>;
  download(path: string): Promise<ReadableStream<Uint8Array>>;
}

export function createOutputFileStore(
  client: WorkspaceClient,
  connector: FilesConnector,
  volume: string,
): OutputFileStore {
  return {
    async size(path) {
      if (!isOutputFilePath(path, { volumes: [volume] }))
        throw new Error("Invalid output file destination.");
      try {
        return parseStorageFileSize(
          (await connector.metadata(client, path)).contentLength,
        );
      } catch (error) {
        if (error instanceof ApiError && error.statusCode === 404)
          return undefined;
        throw error;
      }
    },
    async download(path) {
      if (!isOutputFilePath(path, { volumes: [volume] }))
        throw new Error("Invalid output file destination.");
      const result = await connector.download(client, path);
      if (!result.contents)
        throw new Error("The output file has no readable contents.");
      return result.contents;
    },
  };
}
