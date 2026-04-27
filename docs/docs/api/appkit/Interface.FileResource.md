# Interface: FileResource

Describes the file or directory being acted upon.

## Properties

### path

```ts
path: string;
```

Relative path within the volume.

***

### size?

```ts
optional size: number;
```

Content length in bytes — only present for uploads.

***

### volume

```ts
volume: string;
```

The volume key (e.g. `"uploads"`).
