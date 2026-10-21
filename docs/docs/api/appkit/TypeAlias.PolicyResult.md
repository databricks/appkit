# Type Alias: PolicyResult

```ts
type PolicyResult = 
  | boolean
  | {
  deny: string;
};
```

Only a literal `true` allows; `false` or `{ deny }` refuses with 403.
