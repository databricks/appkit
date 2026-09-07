# Interface: MatchResult

Result of a deterministic matcher run against a value.

## Properties

### detail?

```ts
optional detail: string;
```

Human-readable explanation, shown on failure.

***

### pass

```ts
pass: boolean;
```

***

### score?

```ts
optional score: number;
```

Optional 0..1 score for scored matchers (similarity, judges).
