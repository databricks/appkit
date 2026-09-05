# Interface: EvalRunSummary

## Properties

### mlflow?

```ts
optional mlflow: {
  finish: FinishOutcome;
  report: ReportOutcome;
  runId: string;
};
```

Present when an MLflow evaluation run was created.

#### finish

```ts
finish: FinishOutcome;
```

#### report

```ts
report: ReportOutcome;
```

#### runId

```ts
runId: string;
```

***

### results

```ts
results: EvalResult[];
```
