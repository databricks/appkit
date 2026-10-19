# ~~Interface: DownloadResponse~~

Response object for file downloads containing a readable stream.

## Deprecated

Legacy header-keyed shape; use [FilesDownloadResponse](TypeAlias.FilesDownloadResponse.md).

## Properties

### ~~content-length?~~

```ts
optional content-length: number;
```

***

### ~~content-type?~~

```ts
optional content-type: string;
```

***

### ~~contents?~~

```ts
optional contents: ReadableStream<any>;
```

***

### ~~last-modified?~~

```ts
optional last-modified: string;
```

Last modified time in HTTP-date (RFC 7231) format.
