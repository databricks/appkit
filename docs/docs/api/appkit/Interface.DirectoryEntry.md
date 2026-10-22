# ~~Interface: DirectoryEntry~~

A single entry returned when listing a directory (Files API wire shape).

## Deprecated

Legacy snake_case shape; use [FilesDirectoryEntry](TypeAlias.FilesDirectoryEntry.md).

## Properties

### ~~file\_size?~~

```ts
optional file_size: number;
```

The length of the file in bytes. Omitted for directories.

***

### ~~is\_directory?~~

```ts
optional is_directory: boolean;
```

True if the path is a directory.

***

### ~~last\_modified?~~

```ts
optional last_modified: number;
```

Last modification time in milliseconds since unix epoch.

***

### ~~name?~~

```ts
optional name: string;
```

The name of the file or directory (last path component).

***

### ~~path?~~

```ts
optional path: string;
```

The absolute path of the file or directory.
