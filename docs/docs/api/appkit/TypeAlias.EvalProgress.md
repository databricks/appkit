# Type Alias: EvalProgress

```ts
type EvalProgress = 
  | {
  total: number;
  type: "discovered";
}
  | {
  runId: string;
  type: "run-created";
}
  | {
  id: string;
  index: number;
  total: number;
  type: "start";
}
  | {
  index: number;
  result: EvalResult;
  total: number;
  type: "result";
};
```
