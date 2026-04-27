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
without an `x-forwarded-user` / `x-forwarded-access-token` header.
Policy authors typically check this first to distinguish SP traffic
from end-user traffic.

The flag reflects the **policy user** the plugin selects, which
combines the volume's effective `auth` mode with the headers on the
incoming request. The full matrix:

| Volume `auth`         | Path                           | Headers                       | `isServicePrincipal` | Notes                                                                                          |
| --------------------- | ------------------------------ | ----------------------------- | -------------------- | ---------------------------------------------------------------------------------------------- |
| `service-principal`   | HTTP                           | `x-forwarded-user` present    | `false` (or unset)   | Pre-OBO behavior. Policy sees the end user but the SDK call still runs as the SP.              |
| `service-principal`   | HTTP                           | no `x-forwarded-user`         | `true`               | Headerless request — policy and SDK both run as the SP.                                        |
| `on-behalf-of-user`   | HTTP                           | valid token + user header     | `false`              | Real end-user execution. Policy sees the user; the SDK call also runs as the user.             |
| `on-behalf-of-user`   | HTTP                           | missing token, dev-fallback   | `true`               | Only reachable when `NODE_ENV === "development"` (prod returns 401). Treated as SP traffic.    |
| any                   | Programmatic `asUser(req)`     | `x-forwarded-user` present    | `false`              | `asUser` extracts the user; the SDK call runs as the user inside `runInUserContext`.           |

Programmatic calls without `asUser(req)` always set
`isServicePrincipal: true` because no request is available to derive a
user identity from. OBO volume defaults apply only to HTTP route
traffic; for programmatic per-user execution, use `asUser(req)`.
