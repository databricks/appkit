# Interface: EvalDefinition

A single eval, default-exported from a `*.eval.ts` file.

## Properties

### agent?

```ts
optional agent: string;
```

Target agent id. Defaults to the eval's parent `server/agents/<id>` dir.

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
