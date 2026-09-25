# Type Alias: CallerPrincipal

```ts
type CallerPrincipal = Readonly<{
  type: "user";
  userEmail?: string;
  userId: string;
  userName?: string;
}>;
```

The caller identity whose permissions authorize execution, not its resources.
