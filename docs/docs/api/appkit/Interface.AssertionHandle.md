# Interface: AssertionHandle

Chainable handle returned by every assertion to control its severity.
Mirrors eve: assertions are gates by default; `.soft()` demotes to a tracked
metric; `.atLeast(n)` is a soft, score-thresholded assertion.

## Methods

### atLeast()

```ts
atLeast(threshold: number): AssertionHandle;
```

Set the pass threshold for a scored assertion: it passes only when the
score is at least `threshold`. Keeps the current severity (gate unless also
chained with `.soft()`).

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `threshold` | `number` |

#### Returns

`AssertionHandle`

***

### gate()

```ts
gate(): AssertionHandle;
```

Promote to a hard gate — failure fails the eval (non-zero exit).

#### Returns

`AssertionHandle`

***

### soft()

```ts
soft(): AssertionHandle;
```

Demote to a tracked metric — doesn't fail unless running with `strict`.

#### Returns

`AssertionHandle`
