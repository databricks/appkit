# Interface: ITelemetry

Defined in: [appkit/src/telemetry/types.ts:33](https://github.com/databricks/appkit/blob/main/packages/appkit/src/telemetry/types.ts#L33)

Plugin-facing interface for OpenTelemetry instrumentation.
Provides a thin abstraction over OpenTelemetry APIs for plugins.

## Methods

### emit()

```ts
emit(logRecord): void;
```

Defined in: [appkit/src/telemetry/types.ts:57](https://github.com/databricks/appkit/blob/main/packages/appkit/src/telemetry/types.ts#L57)

Emits a log record using the default logger.
Respects the logs enabled/disabled config.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `logRecord` | `LogRecord` | The log record to emit |

#### Returns

`void`

***

### getLogger()

```ts
getLogger(options?): Logger;
```

Defined in: [appkit/src/telemetry/types.ts:50](https://github.com/databricks/appkit/blob/main/packages/appkit/src/telemetry/types.ts#L50)

Gets a logger for emitting log records.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options?` | `InstrumentConfig` | Instrument customization options. |

#### Returns

`Logger`

***

### getMeter()

```ts
getMeter(options?): Meter;
```

Defined in: [appkit/src/telemetry/types.ts:44](https://github.com/databricks/appkit/blob/main/packages/appkit/src/telemetry/types.ts#L44)

Gets a meter for recording metrics.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options?` | `InstrumentConfig` | Instrument customization options. |

#### Returns

`Meter`

***

### getTracer()

```ts
getTracer(options?): Tracer;
```

Defined in: [appkit/src/telemetry/types.ts:38](https://github.com/databricks/appkit/blob/main/packages/appkit/src/telemetry/types.ts#L38)

Gets a tracer for creating spans.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options?` | `InstrumentConfig` | Instrument customization options. |

#### Returns

`Tracer`

***

### registerInstrumentations()

```ts
registerInstrumentations(instrumentations): void;
```

Defined in: [appkit/src/telemetry/types.ts:81](https://github.com/databricks/appkit/blob/main/packages/appkit/src/telemetry/types.ts#L81)

Register OpenTelemetry instrumentations.
Can be called at any time, but recommended to call in plugin constructor.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `instrumentations` | `Instrumentation`\<`InstrumentationConfig`\>[] | Array of OpenTelemetry instrumentations to register |

#### Returns

`void`

***

### startActiveSpan()

```ts
startActiveSpan<T>(
   name, 
   options, 
   fn, 
tracerOptions?): Promise<T>;
```

Defined in: [appkit/src/telemetry/types.ts:69](https://github.com/databricks/appkit/blob/main/packages/appkit/src/telemetry/types.ts#L69)

Starts an active span and executes a callback function within its context.
Respects the traces enabled/disabled config.
When traces are disabled, executes the callback with a no-op span.

#### Type Parameters

| Type Parameter |
| ------ |
| `T` |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `name` | `string` | The name of the span |
| `options` | `SpanOptions` | Span options including attributes, kind, etc. |
| `fn` | (`span`) => `Promise`\<`T`\> | Callback function to execute within the span context |
| `tracerOptions?` | `InstrumentConfig` | Optional tracer configuration (custom name, prefix inclusion) |

#### Returns

`Promise`\<`T`\>

Promise resolving to the callback's return value
