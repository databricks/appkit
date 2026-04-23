# Interface: FilePolicyUser

Minimal user identity passed to the policy function.

## Properties

### id

```ts
id: string;
```

Identifier of the requesting caller. For end-user HTTP requests this is
the value of the `x-forwarded-user` header; for direct SDK calls and
header-less HTTP requests (which run as the service principal), this is
the service principal's ID.

***

### isServicePrincipal?

```ts
optional isServicePrincipal: boolean;
```

`true` when the call is executing as the service principal — either a
direct SDK call (`appKit.files(...)`) or an HTTP request that arrived
without an `x-forwarded-user` header. Policy authors typically check
this first to distinguish SP traffic from end-user traffic.
