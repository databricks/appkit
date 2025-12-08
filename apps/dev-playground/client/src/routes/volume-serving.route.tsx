import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Header } from "@/components/layout/header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { useDirectoryListing } from "@/hooks/use-directory-listing";

export const Route = createFileRoute("/volume-serving")({
  component: VolumeServingRoute,
  validateSearch: (search: Record<string, unknown>) => {
    return {
      path: (search.path as string) || "/",
    };
  },
});

function formatFileSize(bytes?: number): string {
  if (bytes === undefined || bytes === null) return "-";
  if (bytes === 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${(bytes / k ** i).toFixed(2)} ${units[i]}`;
}

function VolumeServingRoute() {
  const navigate = useNavigate({ from: Route.fullPath });
  const { path } = Route.useSearch();
  const {
    currentPath,
    directoryListing,
    loading,
    error,
    filesWithNavigation,
    handleNavigate,
  } = useDirectoryListing(path, (newPath: string) => {
    navigate({ search: { path: newPath } });
  });

  // Check if error indicates plugin is not configured (404, JSON parse error, or connection refused)
  const isPluginNotConfigured =
    error &&
    (error.includes("404") ||
      error.includes("HTTP error! status: 404") ||
      error.includes("not valid JSON") ||
      error.includes("Unexpected token"));

  return (
    <div className="min-h-[calc(100vh-73px)] bg-gray-50">
      <div className="max-w-7xl mx-auto px-6 py-12">
        <Header
          title="Volume Serving"
          description="Serve files and data directly from Databricks volumes with high performance and scalability."
          tooltip="Learn how to configure and use volume serving in your applications"
        />

        <div className="grid grid-cols-1 gap-6 mt-8">
          <Card>
            <CardHeader>
              <CardTitle>Browse Volume Files</CardTitle>
              <CardDescription>
                {loading
                  ? "Loading..."
                  : "Click on folders to navigate, files to open"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="relative min-h-[400px]">
                {/* Show info overlay when plugin is not configured */}
                {isPluginNotConfigured && (
                  <div className="absolute inset-0 z-20 bg-white/60 backdrop-blur-[1px] flex items-center justify-center rounded-lg pointer-events-none">
                    <div className="max-w-md p-6 text-center bg-white/95 rounded-lg shadow-xl border border-gray-200 pointer-events-auto">
                      <div className="mb-4 text-4xl">ℹ️</div>
                      <h3 className="text-lg font-semibold text-gray-900 mb-2">
                        Volume Serving Not Configured
                      </h3>
                      <p className="text-sm text-gray-600 mb-4">
                        The volume serving plugin is not configured. To enable
                        file browsing, set the{" "}
                        <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs font-mono">
                          VOLUME_PATH
                        </code>{" "}
                        environment variable.
                      </p>
                      <div className="text-left bg-gray-50 border border-gray-200 rounded p-3 mb-4">
                        <p className="text-xs font-semibold text-gray-700 mb-1">
                          Example configuration:
                        </p>
                        <pre className="text-xs font-mono text-gray-800">
                          {`VOLUME_PATH=/Volumes/catalog/schema/volume_name`}
                        </pre>
                      </div>
                      <p className="text-xs text-gray-500">
                        Add this to your{" "}
                        <code className="bg-gray-100 px-1 py-0.5 rounded">
                          .env
                        </code>{" "}
                        file and restart the server.
                      </p>
                    </div>
                  </div>
                )}

                {/* Show error message for other errors */}
                {error && !isPluginNotConfigured && (
                  <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4">
                    <p className="text-sm">{error}</p>
                  </div>
                )}

                {/* File listing table (with or without overlay) */}
                <div className="w-full">
                  <div className="bg-gray-100 px-4 py-2 rounded mb-4 font-mono text-sm">
                    {currentPath || "/"}
                  </div>
                  <div className="border rounded-lg overflow-auto max-h-[60vh]">
                    <Table>
                      <TableHeader className="sticky top-0 bg-white z-10">
                        <TableRow>
                          <TableHead className="w-12"></TableHead>
                          <TableHead className="min-w-[200px]">Name</TableHead>
                          <TableHead className="w-24 text-right">
                            Size
                          </TableHead>
                          <TableHead className="w-24">Type</TableHead>
                          <TableHead className="w-48">MIME Type</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {loading || isPluginNotConfigured ? (
                          // Show skeleton rows while loading or when plugin not configured
                          Array.from({ length: 8 }).map((_, idx) => (
                            // biome-ignore lint/suspicious/noArrayIndexKey: Skeleton rows are static placeholders
                            <TableRow key={`skeleton-${idx}`}>
                              <TableCell>
                                <Skeleton className="h-5 w-5" />
                              </TableCell>
                              <TableCell>
                                <Skeleton className="h-4 w-full max-w-[300px]" />
                              </TableCell>
                              <TableCell className="text-right">
                                <Skeleton className="h-4 w-16 ml-auto" />
                              </TableCell>
                              <TableCell>
                                <Skeleton className="h-4 w-12" />
                              </TableCell>
                              <TableCell>
                                <Skeleton className="h-4 w-32" />
                              </TableCell>
                            </TableRow>
                          ))
                        ) : directoryListing ? (
                          // Show actual files when loaded
                          filesWithNavigation.map((file) => {
                            const isFile =
                              !file.isDirectory && file.name !== "..";
                            const href = isFile
                              ? `/api/volume-serving${file.path}`
                              : "#";

                            return (
                              <TableRow
                                key={file.path}
                                className="hover:bg-gray-50"
                              >
                                <TableCell>
                                  <span className="text-xl">
                                    {file.name === ".."
                                      ? "⬆️"
                                      : file.isDirectory
                                        ? "📁"
                                        : "📄"}
                                  </span>
                                </TableCell>
                                <TableCell className="font-medium">
                                  {isFile ? (
                                    <a
                                      href={href}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-blue-600 hover:text-blue-800 hover:underline"
                                    >
                                      {file.name}
                                    </a>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => handleNavigate(file)}
                                      className="text-left text-blue-600 hover:text-blue-800 hover:underline w-full"
                                    >
                                      {file.name}
                                    </button>
                                  )}
                                </TableCell>
                                <TableCell className="text-right text-muted-foreground">
                                  {formatFileSize(file.size)}
                                </TableCell>
                                <TableCell className="text-muted-foreground">
                                  {file.name === ".."
                                    ? "Parent"
                                    : file.isDirectory
                                      ? "Folder"
                                      : "File"}
                                </TableCell>
                                <TableCell className="text-muted-foreground text-sm">
                                  {file.mimeType || "-"}
                                </TableCell>
                              </TableRow>
                            );
                          })
                        ) : (
                          <TableRow>
                            <TableCell
                              colSpan={5}
                              className="text-center text-sm text-gray-500 py-8"
                            >
                              No files or directories to display
                            </TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>About Volume Serving</CardTitle>
              <CardDescription>
                Serve files directly from Databricks Unity Catalog volumes
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4 text-sm text-gray-600">
                <p>
                  Volume serving allows you to serve files directly from
                  Databricks Unity Catalog volumes. This is ideal for serving
                  static assets, model artifacts, or any files stored in
                  volumes.
                </p>
                <div>
                  <h4 className="font-semibold text-gray-900 mb-2">
                    How to Use
                  </h4>
                  <ul className="list-disc list-inside space-y-1">
                    <li>
                      The browser automatically loads the root directory on page
                      load
                    </li>
                    <li>
                      Click on folder names (📁) to navigate into subdirectories
                    </li>
                    <li>
                      Click on the{" "}
                      <code className="bg-gray-100 px-1 py-0.5 rounded">
                        ..
                      </code>{" "}
                      entry (⬆️) to go up to the parent directory
                    </li>
                    <li>Click on file names (📄) to open them in a new tab</li>
                    <li>Folders are always listed first, followed by files</li>
                  </ul>
                </div>
                <div>
                  <h4 className="font-semibold text-gray-900 mb-2">
                    Configuration
                  </h4>
                  <p className="mb-2">
                    Set the volume path in your server configuration:
                  </p>
                  <pre className="bg-gray-900 text-gray-100 p-3 rounded overflow-auto">
                    {`volumeServing({
  volumePath: process.env.VOLUME_PATH,
  enableDirectoryListing: true
})`}
                  </pre>
                  <p className="mt-2">
                    In your{" "}
                    <code className="bg-gray-100 px-1 py-0.5 rounded">
                      .env
                    </code>{" "}
                    file:
                  </p>
                  <pre className="bg-gray-900 text-gray-100 p-3 rounded overflow-auto mt-1">
                    {`VOLUME_PATH=/Volumes/catalog/schema/volume_name`}
                  </pre>
                </div>
                <div>
                  <h4 className="font-semibold text-gray-900 mb-2">
                    API Access
                  </h4>
                  <ul className="list-disc list-inside space-y-1">
                    <li>
                      Directories:{" "}
                      <code className="bg-gray-100 px-1 py-0.5 rounded">
                        /api/volume-serving/path/to/dir/
                      </code>{" "}
                      (with trailing{" "}
                      <code className="bg-gray-100 px-1 py-0.5 rounded">/</code>
                      )
                    </li>
                    <li>
                      Files:{" "}
                      <code className="bg-gray-100 px-1 py-0.5 rounded">
                        /api/volume-serving/path/to/file.ext
                      </code>{" "}
                      (without trailing{" "}
                      <code className="bg-gray-100 px-1 py-0.5 rounded">/</code>
                      )
                    </li>
                  </ul>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
