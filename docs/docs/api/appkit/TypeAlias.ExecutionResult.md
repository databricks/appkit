# Type Alias: ExecutionResult\<T\>

```ts
type ExecutionResult<T> = 
  | {
  data: T;
  ok: true;
}
  | {
  message: string;
  ok: false;
  status: number;
};
```

Discriminated union for plugin execution results.

Replaces the previous `T | undefined` return type on `execute()`,
preserving the HTTP status code and message from the original error.

## Type Parameters

| Type Parameter |
| ------ |
| `T` |
