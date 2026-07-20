# Interface: EvalDefinition

A single eval, default-exported from a `*.eval.ts` file.

## Properties

### agent?

```ts
optional agent: string;
```

Target agent id. Defaults to the eval's parent `server/agents/<id>` dir.

***

### dataset?

```ts
optional dataset: {
  limit?: number;
  table: string;
};
```

Run this eval once per row of a Databricks managed evaluation dataset (a
Unity Catalog `catalog.schema.table` with `inputs`/`expectations` columns).
Each row is bound to `t.input`/`t.expected`. Requires the runner to have a
workspace client + warehouse (`--warehouse`). Omit for a single-run eval.

#### limit?

```ts
optional limit: number;
```

#### table

```ts
table: string;
```

***

### description?

```ts
optional description: string;
```

Short human description, shown in reports.

## Methods

### test()

```ts
test(t: TestContext): void | Promise<void>;
```

The eval body: drive the agent and assert on its behavior.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `t` | [`TestContext`](Interface.TestContext.md) |

#### Returns

`void` \| `Promise`\<`void`\>
