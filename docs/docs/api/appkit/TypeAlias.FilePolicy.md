# Type Alias: FilePolicy()

```ts
type FilePolicy = (action: FileAction, resource: FileResource, user: FilePolicyUser) => boolean | Promise<boolean>;
```

A policy function that decides whether `user` may perform `action` on
`resource`. Return `true` to allow, `false` to deny.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `action` | [`FileAction`](TypeAlias.FileAction.md) |
| `resource` | [`FileResource`](Interface.FileResource.md) |
| `user` | [`FilePolicyUser`](Interface.FilePolicyUser.md) |

## Returns

`boolean` \| `Promise`\<`boolean`\>
