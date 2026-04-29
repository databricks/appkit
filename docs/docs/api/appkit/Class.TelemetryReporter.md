# Class: TelemetryReporter

## Methods

### flushRequestMetrics()

```ts
flushRequestMetrics(): Promise<TelemetrySendResult | null>;
```

#### Returns

`Promise`\<`TelemetrySendResult` \| `null`\>

***

### recordRequest()

```ts
recordRequest(
   method: string, 
   routeTemplate: string, 
   statusCode: number, 
   latencyMs: number): void;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `method` | `string` |
| `routeTemplate` | `string` |
| `statusCode` | `number` |
| `latencyMs` | `number` |

#### Returns

`void`

***

### sendHeartbeat()

```ts
sendHeartbeat(): Promise<TelemetrySendResult | null>;
```

#### Returns

`Promise`\<`TelemetrySendResult` \| `null`\>

***

### sendStartup()

```ts
sendStartup(): Promise<TelemetrySendResult | null>;
```

#### Returns

`Promise`\<`TelemetrySendResult` \| `null`\>

***

### start()

```ts
start(): void;
```

#### Returns

`void`

***

### stop()

```ts
stop(): void;
```

#### Returns

`void`

***

### getInstance()

```ts
static getInstance(): TelemetryReporter | null;
```

#### Returns

`TelemetryReporter` \| `null`

***

### initialize()

```ts
static initialize(opts: ReporterOptions): TelemetryReporter;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `opts` | `ReporterOptions` |

#### Returns

`TelemetryReporter`
