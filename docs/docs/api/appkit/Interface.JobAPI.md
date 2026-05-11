# Interface: JobAPI

User-facing API for a single configured job.

## Methods

### cancelRun()

```ts
cancelRun(runId: number): Promise<ExecutionResult<void>>;
```

Cancel a specific run.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `runId` | `number` |

#### Returns

`Promise`\<[`ExecutionResult`](TypeAlias.ExecutionResult.md)\<`void`\>\>

***

### getJob()

```ts
getJob(): Promise<ExecutionResult<Job>>;
```

Get the job definition.

#### Returns

`Promise`\<[`ExecutionResult`](TypeAlias.ExecutionResult.md)\<`Job`\>\>

***

### getRun()

```ts
getRun(runId: number): Promise<ExecutionResult<Run>>;
```

Get a specific run by ID.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `runId` | `number` |

#### Returns

`Promise`\<[`ExecutionResult`](TypeAlias.ExecutionResult.md)\<`Run`\>\>

***

### getRunOutput()

```ts
getRunOutput(runId: number): Promise<ExecutionResult<RunOutput>>;
```

Get output of a specific run.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `runId` | `number` |

#### Returns

`Promise`\<[`ExecutionResult`](TypeAlias.ExecutionResult.md)\<`RunOutput`\>\>

***

### lastRun()

```ts
lastRun(): Promise<ExecutionResult<BaseRun | undefined>>;
```

Get the most recent run for this job.

#### Returns

`Promise`\<[`ExecutionResult`](TypeAlias.ExecutionResult.md)\<`BaseRun` \| `undefined`\>\>

***

### listRuns()

```ts
listRuns(options?: {
  limit?: number;
}): Promise<ExecutionResult<BaseRun[]>>;
```

List runs for this job.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options?` | \{ `limit?`: `number`; \} |
| `options.limit?` | `number` |

#### Returns

`Promise`\<[`ExecutionResult`](TypeAlias.ExecutionResult.md)\<`BaseRun`[]\>\>

***

### runAndWait()

```ts
runAndWait(params?: Record<string, unknown>, signal?: AbortSignal): AsyncGenerator<JobRunStatus, void, unknown>;
```

Trigger and poll until completion, yielding status updates.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `params?` | `Record`\<`string`, `unknown`\> |
| `signal?` | `AbortSignal` |

#### Returns

`AsyncGenerator`\<`JobRunStatus`, `void`, `unknown`\>

***

### runNow()

```ts
runNow(params?: Record<string, unknown>): Promise<ExecutionResult<RunNowResponse>>;
```

Trigger the configured job with validated params. Returns the run response.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `params?` | `Record`\<`string`, `unknown`\> |

#### Returns

`Promise`\<[`ExecutionResult`](TypeAlias.ExecutionResult.md)\<`RunNowResponse`\>\>
