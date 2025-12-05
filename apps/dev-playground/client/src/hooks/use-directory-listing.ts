import { useState, useEffect, useCallback } from "react";

interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  mimeType?: string | null;
}

interface DirectoryListing {
  path: string;
  files: FileItem[];
}

export function useDirectoryListing(
  initialPath: string = "/",
  onPathChange?: (path: string) => void,
  batchSize: number = 50,
) {
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [directoryListing, setDirectoryListing] =
    useState<DirectoryListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPath = useCallback(
    async (path: string) => {
      setLoading(true);
      setError(null);
      setDirectoryListing(null);

      // Batch-related variables accessible to both try and catch blocks
      const files: FileItem[] = [];
      let dirPath = path;
      let batchBuffer: FileItem[] = [];
      const effectiveBatchSize = Math.max(1, batchSize); // Clamp to minimum 1

      // Flush function - centralized batch update logic
      const flushBatch = () => {
        if (batchBuffer.length > 0) {
          files.push(...batchBuffer);
          setDirectoryListing({ path: dirPath, files: [...files] });
          batchBuffer = [];
        }
      };

      try {
        // Stream directory listing from NDJSON response
        const response = await fetch(`/api/volume-serving${path}`);

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        // Read the stream line by line
        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        if (reader) {
          while (true) {
            const { done, value } = await reader.read();

            if (done) {
              flushBatch(); // Flush remaining files
              break;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");

            // Process all complete lines
            for (let i = 0; i < lines.length - 1; i++) {
              const line = lines[i].trim();
              if (line) {
                const data = JSON.parse(line);

                if (data.type === "metadata") {
                  dirPath = data.path;
                } else if (data.type === "file") {
                  const fileItem: FileItem = {
                    name: data.name,
                    path: data.path,
                    isDirectory: data.isDirectory,
                    size: data.size,
                    mimeType: data.mimeType,
                  };

                  batchBuffer.push(fileItem);

                  // Flush when batch is full
                  if (batchBuffer.length >= effectiveBatchSize) {
                    flushBatch();
                  }
                }
              }
            }

            // Keep the last incomplete line in the buffer
            buffer = lines[lines.length - 1];
          }
        }
      } catch (err) {
        flushBatch(); // Flush partial batch before error state
        setError(err instanceof Error ? err.message : "Failed to fetch path");
      } finally {
        setLoading(false);
      }
    },
    [batchSize],
  );

  const navigateUp = () => {
    // Remove trailing slash if present
    const cleanPath =
      currentPath.endsWith("/") && currentPath !== "/"
        ? currentPath.slice(0, -1)
        : currentPath;

    // Get parent directory
    const parentPath =
      cleanPath.substring(0, cleanPath.lastIndexOf("/")) || "/";
    const normalizedParent = parentPath === "/" ? "/" : `${parentPath}/`;

    setCurrentPath(normalizedParent);
    onPathChange?.(normalizedParent);
    fetchPath(normalizedParent);
  };

  const handleNavigate = (file: FileItem) => {
    // Handle ".." navigation
    if (file.name === "..") {
      navigateUp();
      return;
    }

    if (file.isDirectory) {
      // Navigate to directory
      const newPath = file.path;
      setCurrentPath(newPath);
      onPathChange?.(newPath);
      fetchPath(newPath);
    } else {
      // Open file in new window
      window.open(`/api/volume-serving${file.path}`, "_blank");
    }
  };

  // Load directory when initialPath changes (including from URL)
  useEffect(() => {
    setCurrentPath(initialPath);
    fetchPath(initialPath);
  }, [initialPath, fetchPath]);

  // Prepare files list with ".." entry if not in root, sorted with folders first
  const filesWithNavigation = directoryListing
    ? [
        ...(currentPath !== "/"
          ? [
              {
                name: "..",
                path: "",
                isDirectory: true,
                size: undefined,
                mimeType: null,
              },
            ]
          : []),
        // Sort: directories first, then by name
        ...directoryListing.files.sort((a, b) => {
          if (a.isDirectory === b.isDirectory) {
            return a.name.localeCompare(b.name);
          }
          return a.isDirectory ? -1 : 1;
        }),
      ]
    : [];

  return {
    currentPath,
    directoryListing,
    loading,
    error,
    filesWithNavigation,
    fetchPath,
    navigateUp,
    handleNavigate,
  };
}
