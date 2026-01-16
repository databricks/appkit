# Interface: ITelemetry

Plugin-facing interface for OpenTelemetry instrumentation.
Provides a thin abstraction over OpenTelemetry APIs for plugins.

## Methods

### emit()

```ts
emit(logRecord: LogRecord): void;
```

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
getLogger(options?: InstrumentConfig): Logger;
```

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
getMeter(options?: InstrumentConfig): Meter;
```

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
getTracer(options?: InstrumentConfig): Tracer;
```

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
registerInstrumentations(instrumentations: Instrumentation<InstrumentationConfig>[]): void;
```

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
   name: string, 
   options: SpanOptions, 
   fn: (span: Span) => Promise<T>, 
tracerOptions?: InstrumentConfig): Promise<T>;
```

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
| `fn` | (`span`: `Span`) => `Promise`\<`T`\> | Callback function to execute within the span context |
| `tracerOptions?` | `InstrumentConfig` | Optional tracer configuration (custom name, prefix inclusion) |

#### Returns

`Promise`\<`T`\>

Promise resolving to the callback's return value
