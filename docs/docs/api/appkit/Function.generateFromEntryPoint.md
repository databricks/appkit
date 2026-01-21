# Function: generateFromEntryPoint()

```ts
function generateFromEntryPoint(options: {
  noCache?: boolean;
  outFile: string;
  queryFolder?: string;
  warehouseId: string;
}): Promise<void>;
```

Entry point for generating type declarations from all imported files

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | \{ `noCache?`: `boolean`; `outFile`: `string`; `queryFolder?`: `string`; `warehouseId`: `string`; \} | the options for the generation |
| `options.noCache?` | `boolean` | - |
| `options.outFile` | `string` | the output file |
| `options.queryFolder?` | `string` | - |
| `options.warehouseId` | `string` | - |

## Returns

`Promise`\<`void`\>
