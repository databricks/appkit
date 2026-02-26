# Interface: DatabaseCredential

Database credentials with OAuth token for Postgres connection

## Properties

### expire\_time

```ts
expire_time: string;
```

Token expiration time in UTC (ISO 8601 format)
Tokens expire after 1 hour from generation

#### Example

```ts
"2026-02-06T17:07:00Z"
```

***

### token

```ts
token: string;
```

OAuth token to use as the password when connecting to Postgres
