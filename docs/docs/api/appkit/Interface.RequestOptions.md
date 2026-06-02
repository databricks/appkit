# Interface: RequestOptions

Mirrors the old SDK's `apiClient.request(...)` arguments. We deliberately
keep the shape (snake-case absent; old keys preserved) so existing call
sites move over without semantic edits.

## Properties

### headers?

```ts
optional headers: Headers;
```

***

### method

```ts
method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD";
```

***

### path

```ts
path: string;
```

Databricks REST path, leading slash included (e.g. "/api/2.0/sql/warehouses").

***

### payload?

```ts
optional payload: unknown;
```

***

### query?

```ts
optional query: Record<string, string | number | boolean | undefined>;
```

Query string parameters.

***

### raw?

```ts
optional raw: boolean;
```

When true, the response is returned as `{ contents: ReadableStream<Uint8Array> }`
instead of parsed as JSON. Used for SSE streaming and binary downloads.

***

### responseHeaders?

```ts
optional responseHeaders: string[];
```

When set, the response headers with these names are returned as a
key/value record. Used for the SCIM Me probe to read
`x-databricks-org-id`.

***

### signal?

```ts
optional signal: AbortSignal;
```

Optional abort signal.
