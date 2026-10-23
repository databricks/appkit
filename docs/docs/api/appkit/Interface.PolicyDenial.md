# Interface: PolicyDenial

An explicit refusal. `reason` stays on the server; HTTP and logs do not receive it.

## Properties

### deny

```ts
readonly deny: "forbidden" | "not-found";
```

***

### reason?

```ts
readonly optional reason: string;
```
