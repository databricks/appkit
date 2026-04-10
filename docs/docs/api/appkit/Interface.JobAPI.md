# Interface: JobAPI

User-facing API for a single configured job.

## Methods

### cancelRun()

```ts
cancelRun(runId: number): Promise<void>;
```

Cancel a specific run.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `runId` | `number` |

#### Returns

`Promise`\<`void`\>

***

### getJob()

```ts
getJob(): Promise<Job | undefined>;
```

Get the job definition.

#### Returns

`Promise`\<`Job` \| `undefined`\>

***

### getRun()

```ts
getRun(runId: number): Promise<Run | undefined>;
```

Get a specific run by ID.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `runId` | `number` |

#### Returns

`Promise`\<`Run` \| `undefined`\>

***

### getRunOutput()

```ts
getRunOutput(runId: number): Promise<RunOutput | undefined>;
```

Get output of a specific run.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `runId` | `number` |

#### Returns

`Promise`\<`RunOutput` \| `undefined`\>

***

### lastRun()

```ts
lastRun(): Promise<BaseRun | undefined>;
```

Get the most recent run for this job.

#### Returns

`Promise`\<`BaseRun` \| `undefined`\>

***

### listRuns()

```ts
listRuns(options?: {
  limit?: number;
}): Promise<BaseRun[] | undefined>;
```

List runs for this job.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options?` | \{ `limit?`: `number`; \} |
| `options.limit?` | `number` |

#### Returns

`Promise`\<`BaseRun`[] \| `undefined`\>

***

### runAndWait()

```ts
runAndWait(params?: Record<string, unknown>): AsyncGenerator<JobRunStatus, void, unknown>;
```

Trigger and poll until completion, yielding status updates.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `params?` | `Record`\<`string`, `unknown`\> |

#### Returns

`AsyncGenerator`\<`JobRunStatus`, `void`, `unknown`\>

***

### runNow()

```ts
runNow(params?: Record<string, unknown>): Promise<RunNowResponse | undefined>;
```

Trigger the configured job with validated params. Returns the run response.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `params?` | `Record`\<`string`, `unknown`\> |

#### Returns

`Promise`\<`RunNowResponse` \| `undefined`\>
