# Function: readEvalDataset()

```ts
function readEvalDataset(client: WorkspaceClient, options: ReadEvalDatasetOptions): Promise<DatasetRow[]>;
```

Read a Databricks managed evaluation dataset (a Unity Catalog table with
`inputs`/`expectations` columns) into rows, over the public SQL Statement
Execution API. Reuses SQLWarehouseConnector for submit/poll/transform
— its result transform already JSON-parses string columns into objects, so
`inputs`/`expectations` come back as records whether the table stores them as
JSON strings or structs.

The Python `mlflow.genai.datasets` API needs a Spark session (no TS
equivalent), so we read the backing table directly.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `client` | `WorkspaceClient` |
| `options` | [`ReadEvalDatasetOptions`](Interface.ReadEvalDatasetOptions.md) |

## Returns

`Promise`\<[`DatasetRow`](Interface.DatasetRow.md)[]\>
