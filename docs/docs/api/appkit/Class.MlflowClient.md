# Class: MlflowClient

A thin client over the Databricks workspace REST API, owning the host + bearer
token so callers (eval-run creation, assessment writes, the judge's serving
endpoint) don't each re-derive URLs or re-attach auth. The host is normalized
once at construction.

## Constructors

### Constructor

```ts
new MlflowClient(host: string, token: string): MlflowClient;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `host` | `string` |
| `token` | `string` |

#### Returns

`MlflowClient`

## Properties

### baseUrl

```ts
readonly baseUrl: string;
```

Normalized workspace base URL (scheme guaranteed, no trailing slash).

## Methods

### post()

```ts
post<T>(path: string, body: unknown): Promise<T>;
```

POST JSON to an MLflow REST endpoint. Returns the parsed JSON body, or
throws with the status + response text so callers can surface a precise
error. Use for calls whose failure should abort (e.g. `runs/create`).

The thrown message embeds up to 500 chars of the upstream response body to
aid debugging. That is fine for the dev-facing eval CLI, but do NOT relay
it into an end-user HTTP response if this client is reused in a request
handler — the body can carry workspace-internal detail.

#### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `T` | `unknown` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `path` | `string` |
| `body` | `unknown` |

#### Returns

`Promise`\<`T`\>

***

### postResult()

```ts
postResult(path: string, body: unknown): Promise<PostResult>;
```

POST JSON without throwing: returns `{ ok, status, error }` so best-effort
writes (e.g. per-trace assessments) can be collected and reported without
aborting the run.

`error` embeds up to 500 chars of the upstream body — same caveat as
[post](#post): fine to log for the dev CLI, don't relay it to end users.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `path` | `string` |
| `body` | `unknown` |

#### Returns

`Promise`\<[`PostResult`](Interface.PostResult.md)\>

***

### servingEndpointsUrl()

```ts
servingEndpointsUrl(): string;
```

OpenAI-compatible base URL for Databricks Model Serving, used as the judge's
`OPENAI_BASE_URL`. Same workspace host + token as the MLflow REST calls.

#### Returns

`string`
