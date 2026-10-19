# Type Alias: FilesDownloadResponse

```ts
type FilesDownloadResponse = WorkspaceFilesDownloadResponse;
```

Download response in the modular SDK shape (`contentLength` is a `bigint`).
`download()` still returns the legacy [DownloadResponse](Interface.DownloadResponse.md); it moves to this
type in a future release.
