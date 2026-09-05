# Interface: EvalResult

The outcome of running one eval.

## Properties

### assertions

```ts
assertions: AssertionResult[];
```

***

### description?

```ts
optional description: string;
```

***

### error?

```ts
optional error: string;
```

Set when the eval threw before completing.

***

### id

```ts
id: string;
```

***

### passed

```ts
passed: boolean;
```

True when all gates passed (and, under strict, all soft assertions too).

***

### skipped?

```ts
optional skipped: {
  reason?: string;
};
```

Set when the eval called `t.skip`.

#### reason?

```ts
optional reason: string;
```

***

### traceId?

```ts
optional traceId: string;
```

MLflow trace id of the eval's last turn, for attaching assessments.
