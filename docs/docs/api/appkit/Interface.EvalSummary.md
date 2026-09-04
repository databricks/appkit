# Interface: EvalSummary

## Properties

### allPassed

```ts
allPassed: boolean;
```

True when no eval failed (skips don't count as failures).

***

### failed

```ts
failed: number;
```

***

### passed

```ts
passed: number;
```

***

### passRate

```ts
passRate: number;
```

Fraction of scored (non-skipped) evals that passed, 0..1 (1 when none scored).

***

### skipped

```ts
skipped: number;
```

***

### total

```ts
total: number;
```
