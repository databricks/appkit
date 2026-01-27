# @databricks/taskflow

A production-grade, durable task execution system for Node.js applications. Built with reliability, observability, and developer experience in mind.

## Features

- **Durable Execution** - Write-ahead log ensures tasks survive process crashes
- **Event Streaming** - Real-time SSE streaming with automatic reconnection
- **Rate Limiting** - Sliding window backpressure with per-user quotas
- **Retry & Recovery** - Exponential backoff, dead letter queue, stale task recovery
- **Type Safety** - Branded types prevent ID mix-ups at compile time
- **Observability** - OpenTelemetry-compatible hooks for traces, metrics, and logs
- **Zero Lock-in** - Pluggable storage backends (SQLite, Lakebase, or custom)

## Installation

```bash
pnpm add @databricks/taskflow
```

## Quick Start

```typescript
import { TaskSystem } from '@databricks/taskflow';

// Create the task system
const taskSystem = new TaskSystem({
  repository: {
    type: 'sqlite',
    database: './.taskflow/tasks.db'
  }
});

// Define a task handler
taskSystem.defineTask('send-email', {
  handler: async (input, ctx) => {
    const { to, subject, body } = input;

    ctx.progress({ status: 'sending' });
    await sendEmail(to, subject, body);

    return { sent: true, timestamp: Date.now() };
  },
  schema: z.object({
    to: z.string().email(),
    subject: z.string(),
    body: z.string()
  })
});

// Initialize and start
await taskSystem.initialize();

// Submit a task
const task = await taskSystem.submit('send-email', {
  input: {
    to: 'user@example.com',
    subject: 'Hello',
    body: 'World'
  },
  userId: 'user-123'
});

// Subscribe to events
for await (const event of taskSystem.subscribe(task.idempotencyKey)) {
  console.log(event.type, event.payload);
}
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      TaskSystem                             │
│            submit() · subscribe() · getStatus()             │
└─────────────────────────────────────────────────────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         ▼                    ▼                    ▼
┌────────────────┐  ┌────────────────┐  ┌────────────────┐
│     Guard      │  │    Delivery    │  │  Persistence   │
│                │  │                │  │                │
│ • Backpressure │  │ • RingBuffer   │  │ • EventLog     │
│ • SlotManager  │  │ • SSE Streams  │  │ • Repository   │
│ • DLQ          │  │ • Reconnect    │  │ • Checkpoints  │
└────────────────┘  └────────────────┘  └────────────────┘
                              │
                    ┌─────────┴─────────┐
                    ▼                   ▼
          ┌────────────────┐  ┌────────────────┐
          │     Flush      │  │   Execution    │
          │                │  │                │
          │ • BatchWriter  │  │ • Executor     │
          │ • CircuitBreak │  │ • Recovery     │
          │ • IPC Worker   │  │ • Heartbeat    │
          └────────────────┘  └────────────────┘
```

## Components

### Guard Layer

Controls task admission and execution concurrency.

```typescript
// Rate limiting configuration
const taskSystem = new TaskSystem({
  guard: {
    backpressure: {
      maxTasksPerWindow: 1000,      // Global rate limit
      maxTasksPerUserWindow: 100,   // Per-user rate limit
      windowSizeMs: 60_000,         // 1 minute window
      maxQueuedSize: 500            // Max queued tasks
    },
    slots: {
      maxExecutionGlobal: 50,       // Max concurrent tasks
      maxExecutionPerUser: 10,      // Per-user concurrency
      slotTimeoutMs: 30_000         // Slot acquisition timeout
    },
    dlq: {
      maxSize: 1000,                // DLQ capacity
      ttlMs: 86_400_000,            // 24 hour TTL
      maxRetries: 3                 // Max retry attempts
    }
  }
});
```

### Delivery Layer

Manages real-time event streaming with reconnection support.

```typescript
// Stream configuration
const taskSystem = new TaskSystem({
  stream: {
    streamBufferSize: 100,          // Events per stream buffer
    streamRetentionMs: 60_000       // Keep closed streams for 1 min
  }
});

// Subscribe with reconnection
const stream = taskSystem.subscribe(idempotencyKey, {
  lastSeq: 42,                      // Resume from sequence 42
  signal: abortController.signal    // Cancellation support
});

for await (const event of stream) {
  console.log(`[${event.seq}] ${event.type}:`, event.payload);
}
```

### Persistence Layer

Provides durable storage with write-ahead logging.

```typescript
// Event log configuration
const taskSystem = new TaskSystem({
  eventLog: {
    eventLogPath: './.taskflow/events.log',
    maxSizeBytesPerFile: 10_485_760,  // 10MB before rotation
    maxAgePerFile: 3_600_000,          // 1 hour max age
    retentionCount: 5                  // Keep 5 rotated files
  },
  repository: {
    type: 'sqlite',
    database: './.taskflow/tasks.db'
  }
});
```

### Flush Layer

Background worker that batches WAL entries to the repository.

```typescript
// Flush configuration
const taskSystem = new TaskSystem({
  flush: {
    flushIntervalMs: 1000,            // Flush every second
    maxBatchSize: 1000,               // Max entries per batch
    circuitBreakerThreshold: 5,       // Open after 5 failures
    circuitBreakerDurationMs: 30_000  // Stay open for 30s
  }
});
```

### Execution Layer

Runs task handlers with retry, timeout, and heartbeat.

```typescript
// Executor configuration
const taskSystem = new TaskSystem({
  executor: {
    heartbeatIntervalMs: 5000,        // Heartbeat every 5s
    defaultTimeoutMs: 300_000,        // 5 minute default timeout
    tickIntervalMs: 100               // Check queue every 100ms
  },
  recovery: {
    staleThresholdMs: 30_000,         // Task stale after 30s
    scanIntervalMs: 10_000,           // Scan every 10s
    maxConcurrentRecoveries: 5        // Max parallel recoveries
  }
});
```

## Task Handlers

### Promise Handler

Simple async function that returns a result.

```typescript
taskSystem.defineTask('process-data', {
  handler: async (input, ctx) => {
    const result = await processData(input);
    return result;
  }
});
```

### Generator Handler

Yields progress events during execution.

```typescript
taskSystem.defineTask('batch-import', {
  handler: async function* (input, ctx) {
    const items = input.items;

    for (let i = 0; i < items.length; i++) {
      await processItem(items[i]);

      yield {
        type: 'progress',
        payload: {
          processed: i + 1,
          total: items.length
        }
      };
    }

    return { imported: items.length };
  }
});
```

### Recovery Handler

Custom logic for recovering stale tasks.

```typescript
taskSystem.defineTask('long-running-job', {
  handler: async (input, ctx) => {
    // Normal execution
  },
  recovery: async (task, ctx) => {
    // Check external state
    const status = await checkJobStatus(task.id);

    if (status === 'completed') {
      return { recovered: true, result: status.result };
    }

    // Re-execute from checkpoint
    return { recovered: false };
  }
});
```

## Observability

TaskFlow uses a hooks-based observability interface compatible with OpenTelemetry.

```typescript
import { createHooks } from '@databricks/taskflow';
import { trace, metrics } from '@opentelemetry/api';

const hooks = createHooks({
  tracer: trace.getTracer('taskflow'),
  meter: metrics.getMeter('taskflow'),
  logger: console
});

const taskSystem = new TaskSystem(config, hooks);
```

### Available Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `taskflow.tasks.submitted` | Counter | Tasks submitted |
| `taskflow.tasks.completed` | Counter | Tasks completed |
| `taskflow.tasks.failed` | Counter | Tasks failed |
| `taskflow.tasks.running` | Gauge | Currently running tasks |
| `taskflow.tasks.queued` | Gauge | Tasks waiting in queue |
| `taskflow.guard.rejections` | Counter | Rejected by rate limit |
| `taskflow.dlq.size` | Gauge | Dead letter queue size |
| `taskflow.flush.entries` | Counter | Entries flushed |
| `taskflow.streams.active` | Gauge | Active SSE streams |

### Available Spans

| Span | Description |
|------|-------------|
| `taskflow.task.execute` | Full task execution |
| `taskflow.task.handler` | Handler function only |
| `taskflow.flush.batch` | Batch flush operation |
| `taskflow.recovery.scan` | Recovery scan cycle |

## Error Handling

TaskFlow provides typed errors with retry information.

```typescript
import {
  BackpressureError,
  SlotTimeoutError,
  ValidationError
} from '@databricks/taskflow';

try {
  await taskSystem.submit('my-task', { input: data });
} catch (error) {
  if (BackpressureError.is(error)) {
    // Rate limited - retry after delay
    console.log(`Retry after ${error.retryAfterMs}ms`);
  }

  if (SlotTimeoutError.is(error)) {
    // No execution slots available
    console.log(`Slot timeout after ${error.timeoutMs}ms`);
  }

  if (ValidationError.is(error)) {
    // Invalid input
    console.log(`Invalid field: ${error.field}`);
  }
}
```

## Graceful Shutdown

TaskFlow handles shutdown gracefully, completing in-flight tasks.

```typescript
// Configure shutdown behavior
const taskSystem = new TaskSystem({
  shutdown: {
    timeoutMs: 30_000,              // Max shutdown time
    forceKillTimeoutMs: 5_000       // Force kill after this
  }
});

// Shutdown on SIGTERM
process.on('SIGTERM', async () => {
  await taskSystem.shutdown();
  process.exit(0);
});
```

## Storage Backends

### SQLite (Default)

Best for single-node deployments and development.

```typescript
const taskSystem = new TaskSystem({
  repository: {
    type: 'sqlite',
    database: './.taskflow/tasks.db'
  }
});
```

### Lakebase

For distributed deployments with Databricks Lakebase.

```typescript
const taskSystem = new TaskSystem({
  repository: {
    type: 'lakebase',
    connector: myLakebaseConnector  // You provide the connector
  }
});
```

### Custom Repository

Implement the `TaskRepository` interface for custom backends.

```typescript
interface TaskRepository {
  initialize(): Promise<void>;
  executeBatch(entries: EventLogEntry[]): Promise<void>;
  findById(taskId: TaskId): Promise<Task | null>;
  findByIdempotencyKey(key: IdempotencyKey): Promise<Task | null>;
  findStaleTasks(threshold: number): Promise<Task[]>;
  getEvents(taskId: TaskId): Promise<StoredEvent[]>;
  healthCheck(): Promise<boolean>;
  close(): Promise<void>;
}
```

## API Reference

### TaskSystem

| Method | Description |
|--------|-------------|
| `initialize()` | Initialize all components |
| `defineTask(name, definition)` | Register a task handler |
| `submit(name, params)` | Submit a task for execution |
| `getStatus(idempotencyKey)` | Get task status |
| `subscribe(idempotencyKey, options?)` | Subscribe to task events |
| `getStats()` | Get system statistics |
| `shutdown(options?)` | Graceful shutdown |

### Task Events

| Event Type | Description |
|------------|-------------|
| `created` | Task created and queued |
| `start` | Task execution started |
| `progress` | Progress update from handler |
| `heartbeat` | Periodic heartbeat |
| `complete` | Task completed successfully |
| `error` | Task failed with error |
| `custom` | Custom event from handler |

## License

Apache-2.0
