# Type Alias: FilesDirectoryEntry

```ts
type FilesDirectoryEntry = WorkspaceFilesDirectoryEntry;
```

A single directory entry in the modular SDK shape (camelCase). `list()` and
the `/list` route still return the legacy [DirectoryEntry](Interface.DirectoryEntry.md); they move to
this type in a future release.
