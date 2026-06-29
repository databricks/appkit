# Interface: EvalDefinition

A single eval, default-exported from a `*.eval.ts` file.

## Properties

### agent?

```ts
optional agent: string;
```

Target agent id. Defaults to the eval's parent `config/agents/<id>` dir.

***

### description?

```ts
optional description: string;
```

Short human description, shown in reports.

***

### tags?

```ts
optional tags: string[];
```

Free-form tags for filtering.

***

### timeoutMs?

```ts
optional timeoutMs: number;
```

Per-eval timeout.

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
