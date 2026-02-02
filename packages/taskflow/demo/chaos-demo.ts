/**
 * TaskFlow Chaos & Reliability Demo
 *
 * Demonstrates TaskFlow's resilience features with realistic scenarios:
 *
 * SCENARIOS:
 *   1. BASELINE      - Normal operation, establish throughput baseline
 *   2. BURST         - Sudden spike → backpressure & rate limiting
 *   3. FAILURES      - Random failures → retry with exponential backoff
 *   4. HANGING       - Stuck tasks → stale detection & recovery
 *   5. CHECKPOINT    - Mid-task failures → smart recovery from checkpoint
 *   6. DLQ           - Poison pills → DLQ management & retry
 *   7. DRAIN         - Graceful shutdown with pending work
 *
 * FEATURES DEMONSTRATED:
 *   ✓ Backpressure (queue full, rate limits)
 *   ✓ Retry with exponential backoff
 *   ✓ Stale task detection & recovery
 *   ✓ Smart recovery from checkpoints
 *   ✓ Dead Letter Queue management
 *   ✓ Graceful degradation under load
 *
 * Environment variables:
 *   DEMO_SCENARIO_DURATION=8000   Duration per scenario in ms
 *   DEMO_MAX_CONCURRENT=15        Max concurrent executions
 *
 * Run with: npx tsx demo/chaos-demo.ts
 */

import {
  TaskSystem,
  userId,
  idempotencyKey,
  type TaskSystemStats,
  type TaskHandlerContext,
  type RecoveryContext
} from '../src/index.js';

// ═══════════════════════════════════════════════════════════════════════════════
// ANSI Terminal Utilities
// ═══════════════════════════════════════════════════════════════════════════════

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  blink: '\x1b[5m',

  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',

  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',

  clearScreen: '\x1b[2J',
  cursorHome: '\x1b[H',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
};

function color(text: string, ...codes: string[]): string {
  return codes.join('') + text + ANSI.reset;
}

function progressBar(value: number, max: number, width: number = 20): string {
  const pct = Math.min(1, Math.max(0, max > 0 ? value / max : 0));
  const filled = Math.round(pct * width);
  const empty = width - filled;

  let barColor = ANSI.green;
  if (pct > 0.9) barColor = ANSI.red;
  else if (pct > 0.7) barColor = ANSI.yellow;

  return `${barColor}${'█'.repeat(filled)}${ANSI.dim}${'░'.repeat(empty)}${ANSI.reset}`;
}

function sparkline(values: number[], width: number = 20): string {
  const chars = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  const recent = values.slice(-width);
  if (recent.length === 0) return color('─'.repeat(width), ANSI.dim);

  const max = Math.max(...recent, 1);
  return recent.map(v => {
    const idx = Math.floor((v / max) * (chars.length - 1));
    return color(chars[idx], ANSI.cyan);
  }).join('');
}

function formatDuration(ms: number): string {
  if (ms >= 60000) return (ms / 60000).toFixed(1) + 'm';
  if (ms >= 1000) return (ms / 1000).toFixed(1) + 's';
  return ms.toFixed(0) + 'ms';
}

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario Types
// ═══════════════════════════════════════════════════════════════════════════════

type Scenario = 'baseline' | 'burst' | 'failures' | 'hanging' | 'checkpoint' | 'dlq' | 'drain';

interface ScenarioConfig {
  name: string;
  icon: string;
  color: string;
  description: string;
  tasksToSubmit: number;
  submissionDelay: { min: number; max: number };
}

const SCENARIOS: Record<Scenario, ScenarioConfig> = {
  baseline: {
    name: 'BASELINE',
    icon: '📊',
    color: ANSI.green,
    description: 'Normal operation - establishing throughput baseline',
    tasksToSubmit: 40,
    submissionDelay: { min: 30, max: 60 },
  },
  burst: {
    name: 'BURST',
    icon: '🌊',
    color: ANSI.blue,
    description: 'Sudden traffic spike - testing backpressure & queue limits',
    tasksToSubmit: 200, // Many tasks
    submissionDelay: { min: 0, max: 5 }, // Almost instant
  },
  failures: {
    name: 'FAILURES',
    icon: '💥',
    color: ANSI.red,
    description: 'Random failures - testing retry with exponential backoff',
    tasksToSubmit: 50,
    submissionDelay: { min: 20, max: 40 },
  },
  hanging: {
    name: 'SLOW',
    icon: '🐢',
    color: ANSI.yellow,
    description: 'Slow tasks - testing queue buildup & slot exhaustion',
    tasksToSubmit: 60,
    submissionDelay: { min: 10, max: 20 },
  },
  checkpoint: {
    name: 'MIXED',
    icon: '🎲',
    color: ANSI.magenta,
    description: 'Mixed workload - failures during processing with checkpoints',
    tasksToSubmit: 40,
    submissionDelay: { min: 30, max: 50 },
  },
  dlq: {
    name: 'POISON',
    icon: '☠️',
    color: ANSI.red,
    description: 'Poison pills - tasks that always fail, exhaust retries',
    tasksToSubmit: 20,
    submissionDelay: { min: 50, max: 80 },
  },
  drain: {
    name: 'DRAIN',
    icon: '🚰',
    color: ANSI.cyan,
    description: 'Graceful shutdown - draining remaining tasks',
    tasksToSubmit: 0,
    submissionDelay: { min: 0, max: 0 },
  },
};

interface DemoMetrics {
  startTime: number;
  currentScenario: Scenario;
  scenarioStartTime: number;
  scenarioDurationMs: number;

  // Task counts
  tasksSubmitted: number;
  tasksRejected: number;

  // Scenario-specific events
  events: {
    backpressureRejections: number;
    retriesAttempted: number;
    retriesSucceeded: number;
    retriesExhausted: number;
    staleTasks: number;
    recoveredTasks: number;
    checkpointRecoveries: number;
    dlqAdded: number;
    dlqRetried: number;
    dlqExpired: number;
  };

  // Time series
  throughputHistory: number[];
  failureHistory: number[];
  queueHistory: number[];
  recoveryHistory: number[];

  // Per-second counters
  currentSecond: number;
  currentSecondSubmissions: number;
  currentSecondFailures: number;
  currentSecondRecoveries: number;

  // Peaks
  peakQueued: number;
  peakExecuting: number;
  peakDLQ: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Dashboard Renderer
// ═══════════════════════════════════════════════════════════════════════════════

function renderDashboard(stats: TaskSystemStats, metrics: DemoMetrics): string {
  const lines: string[] = [];
  const elapsed = Date.now() - metrics.startTime;
  const scenarioElapsed = Date.now() - metrics.scenarioStartTime;
  const scenarioProgress = Math.min(1, scenarioElapsed / metrics.scenarioDurationMs);
  const scenario = SCENARIOS[metrics.currentScenario];

  // Header
  lines.push('');
  lines.push(color('╔══════════════════════════════════════════════════════════════════════════════╗', ANSI.cyan, ANSI.bold));
  lines.push(color('║', ANSI.cyan) + color('              🎭 TASKFLOW RELIABILITY DEMO 🎭                              ', ANSI.yellow, ANSI.bold) + color('║', ANSI.cyan));
  lines.push(color('╠══════════════════════════════════════════════════════════════════════════════╣', ANSI.cyan));

  // Current Scenario
  const scenarioBar = progressBar(scenarioProgress, 1, 15);
  const pct = (scenarioProgress * 100).toFixed(0);
  lines.push(color('║', ANSI.cyan) + ` ${scenario.icon} ${color(scenario.name, scenario.color, ANSI.bold)} ${scenarioBar} ${pct}%   Elapsed: ${color(formatDuration(elapsed), ANSI.white)}`.padEnd(95) + color('║', ANSI.cyan));
  lines.push(color('║', ANSI.cyan) + `   ${color(scenario.description, ANSI.dim)}`.padEnd(87) + color('║', ANSI.cyan));

  // System Status
  const statusColor = stats.system.status === 'running' ? ANSI.green :
                      stats.system.status === 'degraded' ? ANSI.yellow : ANSI.red;
  lines.push(color('║', ANSI.cyan) + `   System: ${color(stats.system.status.toUpperCase(), statusColor, ANSI.bold)}`.padEnd(87) + color('║', ANSI.cyan));

  lines.push(color('╠══════════════════════════════════════════════════════════════════════════════╣', ANSI.cyan));

  // Live Metrics Row
  const guard = stats.components.guard;
  const executor = stats.components.executor;

  lines.push(color('║', ANSI.cyan) + color(' 📈 LIVE METRICS', ANSI.magenta, ANSI.bold).padEnd(86) + color('║', ANSI.cyan));

  // Queue and execution
  const queueBar = progressBar(stats.tasks.queued, 75, 12);
  const execBar = progressBar(stats.tasks.executing, 15, 12);
  lines.push(color('║', ANSI.cyan) + `   Queue: ${queueBar} ${color(stats.tasks.queued.toString().padStart(3), ANSI.yellow)}   Exec: ${execBar} ${color(stats.tasks.executing.toString().padStart(2), ANSI.cyan)}/15   In-Flight: ${color(stats.tasks.inFlight.toString(), ANSI.white)}`.padEnd(96) + color('║', ANSI.cyan));

  // Completed/Failed
  const successRate = (stats.tasks.successRate ?? 0) * 100;
  const rateColor = successRate >= 95 ? ANSI.green : successRate >= 80 ? ANSI.yellow : ANSI.red;
  lines.push(color('║', ANSI.cyan) + `   Done: ${color(stats.tasks.totalCompleted.toString(), ANSI.green)}   Failed: ${color(stats.tasks.totalFailed.toString(), ANSI.red)}   Rate: ${color(successRate.toFixed(0) + '%', rateColor)}   Submitted: ${metrics.tasksSubmitted}`.padEnd(96) + color('║', ANSI.cyan));

  // Sparklines
  lines.push(color('║', ANSI.cyan) + `   Throughput: ${sparkline(metrics.throughputHistory, 18)}  Queue: ${sparkline(metrics.queueHistory, 18)}`.padEnd(96) + color('║', ANSI.cyan));

  lines.push(color('╠══════════════════════════════════════════════════════════════════════════════╣', ANSI.cyan));

  // Feature Demonstration Status
  lines.push(color('║', ANSI.cyan) + color(' 🎯 FEATURES DEMONSTRATED', ANSI.magenta, ANSI.bold).padEnd(86) + color('║', ANSI.cyan));

  // Row 1: Backpressure & Retries
  const bpIcon = metrics.events.backpressureRejections > 0 ? '✓' : '○';
  const bpColor = metrics.events.backpressureRejections > 0 ? ANSI.green : ANSI.dim;
  const retryIcon = metrics.events.retriesAttempted > 0 ? '✓' : '○';
  const retryColor = metrics.events.retriesAttempted > 0 ? ANSI.green : ANSI.dim;

  lines.push(color('║', ANSI.cyan) + `   ${color(bpIcon, bpColor)} Backpressure: ${color(metrics.events.backpressureRejections.toString(), ANSI.yellow)} rejected   ${color(retryIcon, retryColor)} Retries: ${color(metrics.events.retriesAttempted.toString(), ANSI.yellow)}→${color(metrics.events.retriesSucceeded.toString(), ANSI.green)}→${color(metrics.events.retriesExhausted.toString(), ANSI.red)}`.padEnd(96) + color('║', ANSI.cyan));

  // Row 2: Recovery & DLQ
  const recoveryIcon = metrics.events.recoveredTasks > 0 ? '✓' : '○';
  const recoveryColor = metrics.events.recoveredTasks > 0 ? ANSI.green : ANSI.dim;
  const dlqIcon = metrics.events.dlqAdded > 0 ? '✓' : '○';
  const dlqColor = metrics.events.dlqAdded > 0 ? ANSI.green : ANSI.dim;

  lines.push(color('║', ANSI.cyan) + `   ${color(recoveryIcon, recoveryColor)} Recovery: ${color(metrics.events.staleTasks.toString(), ANSI.yellow)} stale → ${color(metrics.events.recoveredTasks.toString(), ANSI.green)} recovered   ${color(dlqIcon, dlqColor)} DLQ: ${color(metrics.events.dlqAdded.toString(), ANSI.red)}→${color(metrics.events.dlqRetried.toString(), ANSI.cyan)}`.padEnd(96) + color('║', ANSI.cyan));

  // Row 3: Checkpoints
  const cpIcon = metrics.events.checkpointRecoveries > 0 ? '✓' : '○';
  const cpColor = metrics.events.checkpointRecoveries > 0 ? ANSI.green : ANSI.dim;
  lines.push(color('║', ANSI.cyan) + `   ${color(cpIcon, cpColor)} Checkpoint Recovery: ${color(metrics.events.checkpointRecoveries.toString(), ANSI.green)} resumed from checkpoint`.padEnd(87) + color('║', ANSI.cyan));

  lines.push(color('╠══════════════════════════════════════════════════════════════════════════════╣', ANSI.cyan));

  // Guard System Details
  lines.push(color('║', ANSI.cyan) + color(' 🛡️  GUARD SYSTEM', ANSI.magenta, ANSI.bold).padEnd(86) + color('║', ANSI.cyan));

  const admission = guard.admission;
  const rejections = admission.rejections.byReason;
  lines.push(color('║', ANSI.cyan) + `   Window: ${admission.window.accepted}/${admission.config.maxTasksPerWindow}   Rejected: Global:${color((rejections.global_rate_limit || 0).toString(), ANSI.red)} User:${color((rejections.user_rate_limit || 0).toString(), ANSI.red)} Queue:${color((rejections.queue_full || 0).toString(), ANSI.red)}`.padEnd(96) + color('║', ANSI.cyan));

  // DLQ Status
  const dlq = guard.dlq;
  const dlqBar = progressBar(dlq.size, 20, 10);
  lines.push(color('║', ANSI.cyan) + `   DLQ: ${dlqBar} ${color(dlq.size.toString(), dlq.size > 0 ? ANSI.red : ANSI.green)} entries   Age: ${dlq.avgAgeMs > 0 ? formatDuration(dlq.avgAgeMs) : '-'}`.padEnd(96) + color('║', ANSI.cyan));

  lines.push(color('╠══════════════════════════════════════════════════════════════════════════════╣', ANSI.cyan));

  // Recovery System
  const recovery = stats.components.recovery;
  lines.push(color('║', ANSI.cyan) + color(' 🔄 RECOVERY SYSTEM', ANSI.magenta, ANSI.bold).padEnd(86) + color('║', ANSI.cyan));
  lines.push(color('║', ANSI.cyan) + `   Scanning: ${recovery.background.isScanning ? color('YES', ANSI.yellow) : color('no', ANSI.dim)}   Recovered: ${color(recovery.outcomes.background.toString(), ANSI.green)} bg / ${color(recovery.outcomes.user.toString(), ANSI.cyan)} user   Failed: ${color(recovery.outcomes.failed.toString(), ANSI.red)}`.padEnd(96) + color('║', ANSI.cyan));

  if (recovery.outcomes.byMethod.smartRecovery > 0 || recovery.outcomes.byMethod.reexecution > 0) {
    lines.push(color('║', ANSI.cyan) + `   Method: Smart:${color(recovery.outcomes.byMethod.smartRecovery.toString(), ANSI.green)} Re-exec:${color(recovery.outcomes.byMethod.reexecution.toString(), ANSI.yellow)}`.padEnd(87) + color('║', ANSI.cyan));
  }

  lines.push(color('╠══════════════════════════════════════════════════════════════════════════════╣', ANSI.cyan));

  // Executor
  lines.push(color('║', ANSI.cyan) + color(' ⚡ EXECUTOR', ANSI.magenta, ANSI.bold).padEnd(86) + color('║', ANSI.cyan));
  lines.push(color('║', ANSI.cyan) + `   Running: ${executor.current.executing}   Heartbeats: ${executor.current.heartbeatsActive}   Retries: ${executor.retries.attempted}→${executor.retries.succeeded}→${executor.retries.exhausted}`.padEnd(96) + color('║', ANSI.cyan));

  lines.push(color('╚══════════════════════════════════════════════════════════════════════════════╝', ANSI.cyan, ANSI.bold));
  lines.push('');
  lines.push(color('  Press Ctrl+C to stop', ANSI.dim));

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════════

interface DemoConfig {
  scenarioDurationMs: number;
  maxConcurrent: number;
}

function loadConfig(): DemoConfig {
  return {
    scenarioDurationMs: parseInt(process.env.DEMO_SCENARIO_DURATION ?? '8000', 10),
    maxConcurrent: parseInt(process.env.DEMO_MAX_CONCURRENT ?? '15', 10),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main Demo
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  const config = loadConfig();

  console.log(ANSI.clearScreen + ANSI.cursorHome + ANSI.hideCursor);
  console.log(color('\n  Initializing TaskFlow Reliability Demo...', ANSI.cyan, ANSI.bold));
  console.log(color(`  Scenarios: BASELINE → BURST → FAILURES → HANGING → CHECKPOINT → DLQ → DRAIN`, ANSI.dim));
  console.log(color(`  Concurrency: ${config.maxConcurrent} slots   Scenario duration: ${config.scenarioDurationMs}ms`, ANSI.dim));

  const demoDir = './.taskflow-chaos-demo';
  const { mkdir, rm } = await import('node:fs/promises');
  await rm(demoDir, { recursive: true, force: true });
  await mkdir(demoDir, { recursive: true });

  // Initialize with tight constraints to trigger resilience features
  const taskSystem = new TaskSystem({
    repository: {
      type: 'sqlite',
      database: `${demoDir}/demo.db`
    },
    eventLog: {
      eventLogPath: `${demoDir}/event.log`,
      maxSizeBytesPerFile: 5_242_880,
      maxAgePerFile: 1_800_000,
      retentionCount: 2
    },
    guard: {
      backpressure: {
        windowSizeMs: 30_000,
        maxTasksPerWindow: 500,
        maxTasksPerUserWindow: 50,
        maxQueuedSize: 75 // Small queue to trigger backpressure
      },
      slots: {
        maxExecutionGlobal: config.maxConcurrent,
        maxExecutionPerUser: 5,
        slotTimeoutMs: 30_000
      },
      dlq: {
        maxSize: 50,
        ttlMs: 30_000, // 30 second TTL for demo
        cleanupIntervalMs: 5_000,
        maxRetries: 2
      },
      recovery: {
        maxRecoverySlots: 5,
        recoverySlotTimeoutMs: 30_000
      }
    },
    executor: {
      heartbeatIntervalMs: 2_000, // Fast heartbeats
      retry: {
        maxAttempts: 3,
        initialDelayMs: 100,
        maxDelayMs: 1_000,
        backoffMultiplier: 2
      }
    },
    flush: {
      eventLogPath: `${demoDir}/event.log`,
    },
    recovery: {
      enabled: true,
      backgroundPollIntervalMs: 3_000, // Check every 3 seconds
      staleThresholdMs: 6_000, // 6 second stale threshold (short for demo)
      batchSize: 10,
      completionTimeoutMs: 15_000,
      heartbeatIntervalMs: 2_000
    },
    shutdown: {
      gracePeriodMs: 10_000,
      pollIntervalMs: 100
    }
  });

  await taskSystem.initialize();
  console.log(color('  TaskFlow initialized!', ANSI.green, ANSI.bold));

  // ═══════════════════════════════════════════════════════════════════════════════
  // Task Handlers for Different Scenarios
  // ═══════════════════════════════════════════════════════════════════════════════

  // Track which tasks should exhibit special behavior
  const taskBehaviors = new Map<number, 'normal' | 'fail' | 'slow' | 'checkpoint_fail' | 'poison'>();
  let taskCounter = 0;

  // Task with configurable behaviors
  const demoTask = taskSystem.registerTask({
    name: 'demo-task',
    description: 'Task with configurable behavior for demo scenarios',
    type: 'user',

    handler: async function* (input: { id: number }, _ctx: TaskHandlerContext) {
      const behavior = taskBehaviors.get(input.id) ?? 'normal';

      // POISON: Always fails (exhausts all retries)
      if (behavior === 'poison') {
        yield { type: 'progress', message: 'Starting poison task...', payload: { step: 0 } };
        await sleep(50);
        throw new Error(`POISON_PILL: Task ${input.id} always fails - exhausting retries`);
      }

      // FAIL: High failure rate with retries
      if (behavior === 'fail') {
        yield { type: 'progress', message: 'Starting risky task...', payload: { step: 0 } };
        await sleep(100 + Math.random() * 100);

        if (Math.random() < 0.6) { // 60% fail on first attempt
          throw new Error(`RANDOM_FAILURE: Task ${input.id} failed - will retry`);
        }

        yield { type: 'progress', message: 'Task succeeded', payload: { step: 1 } };
        return { id: input.id, completed: true, behavior };
      }

      // SLOW: Takes longer to complete (fills queue)
      if (behavior === 'slow') {
        const steps = 5;
        for (let step = 1; step <= steps; step++) {
          await sleep(400 + Math.random() * 200); // 400-600ms per step = 2-3s total
          yield {
            type: 'progress',
            message: `Slow step ${step}/${steps}`,
            payload: { step, total: steps }
          };
        }
        return { id: input.id, steps, completed: true, behavior };
      }

      // CHECKPOINT_FAIL: Fail mid-way, checkpoints allow smart recovery
      if (behavior === 'checkpoint_fail') {
        for (let step = 1; step <= 5; step++) {
          await sleep(150);
          yield {
            type: 'progress',
            message: `Checkpoint step ${step}/5`,
            payload: { step, total: 5, checkpoint: step }
          };

          // 50% chance to fail at step 2 or 3
          if ((step === 2 || step === 3) && Math.random() < 0.5) {
            throw new Error(`MID_TASK_FAILURE: Task ${input.id} failed at checkpoint ${step}`);
          }
        }
        return { id: input.id, completed: true, behavior };
      }

      // NORMAL: Quick completion
      const steps = 2 + Math.floor(Math.random() * 2);
      for (let step = 1; step <= steps; step++) {
        await sleep(100 + Math.random() * 100);
        yield {
          type: 'progress',
          message: `Step ${step}/${steps}`,
          payload: { step, total: steps }
        };
      }

      return { id: input.id, steps, completed: true, behavior };
    },

    // Smart recovery - resume from checkpoint
    recover: async function* (input: { id: number }, ctx: RecoveryContext) {
      const lastProgress = ctx.previousEvents
        .filter(e => e.type === 'progress')
        .pop();

      const lastStep = (lastProgress?.payload?.checkpoint as number) ?? 0;

      yield {
        type: 'recovered',
        message: `Recovering task ${input.id} from checkpoint ${lastStep}`,
        payload: { reason: ctx.recoveryReason, fromStep: lastStep }
      };

      // Complete remaining steps from checkpoint
      for (let step = lastStep + 1; step <= 5; step++) {
        await sleep(100);
        yield {
          type: 'progress',
          message: `Resumed: step ${step}/5`,
          payload: { step, total: 5, checkpoint: step, recovered: true }
        };
      }

      return { id: input.id, recovered: true, fromStep: lastStep };
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // Metrics
  // ═══════════════════════════════════════════════════════════════════════════════

  const metrics: DemoMetrics = {
    startTime: Date.now(),
    currentScenario: 'baseline',
    scenarioStartTime: Date.now(),
    scenarioDurationMs: config.scenarioDurationMs,

    tasksSubmitted: 0,
    tasksRejected: 0,

    events: {
      backpressureRejections: 0,
      retriesAttempted: 0,
      retriesSucceeded: 0,
      retriesExhausted: 0,
      staleTasks: 0,
      recoveredTasks: 0,
      checkpointRecoveries: 0,
      dlqAdded: 0,
      dlqRetried: 0,
      dlqExpired: 0,
    },

    throughputHistory: [],
    failureHistory: [],
    queueHistory: [],
    recoveryHistory: [],

    currentSecond: Math.floor(Date.now() / 1000),
    currentSecondSubmissions: 0,
    currentSecondFailures: 0,
    currentSecondRecoveries: 0,

    peakQueued: 0,
    peakExecuting: 0,
    peakDLQ: 0,
  };

  // ═══════════════════════════════════════════════════════════════════════════════
  // Tracking
  // ═══════════════════════════════════════════════════════════════════════════════

  let lastRetryAttempted = 0;
  let lastRetrySucceeded = 0;
  let lastRetryExhausted = 0;
  let lastRecovered = 0;
  let lastDlqAdded = 0;
  let lastDlqRetried = 0;

  const renderInterval = setInterval(() => {
    const stats = taskSystem.getStats();

    // Track peaks
    if (stats.tasks.queued > metrics.peakQueued) metrics.peakQueued = stats.tasks.queued;
    if (stats.tasks.executing > metrics.peakExecuting) metrics.peakExecuting = stats.tasks.executing;
    if (stats.components.guard.dlq.size > metrics.peakDLQ) metrics.peakDLQ = stats.components.guard.dlq.size;

    // Track retries
    const executor = stats.components.executor;
    if (executor.retries.attempted > lastRetryAttempted) {
      metrics.events.retriesAttempted += executor.retries.attempted - lastRetryAttempted;
    }
    if (executor.retries.succeeded > lastRetrySucceeded) {
      metrics.events.retriesSucceeded += executor.retries.succeeded - lastRetrySucceeded;
    }
    if (executor.retries.exhausted > lastRetryExhausted) {
      metrics.events.retriesExhausted += executor.retries.exhausted - lastRetryExhausted;
    }
    lastRetryAttempted = executor.retries.attempted;
    lastRetrySucceeded = executor.retries.succeeded;
    lastRetryExhausted = executor.retries.exhausted;

    // Track recovery
    const recovery = stats.components.recovery.outcomes;
    if (recovery.background > lastRecovered) {
      const delta = recovery.background - lastRecovered;
      metrics.events.recoveredTasks += delta;
      metrics.events.checkpointRecoveries += recovery.byMethod.smartRecovery - (lastRecovered > 0 ? recovery.byMethod.smartRecovery - delta : 0);
      metrics.currentSecondRecoveries += delta;
    }
    lastRecovered = recovery.background;

    // Track DLQ
    const dlq = stats.components.guard.dlq;
    if (dlq.totalAdded > lastDlqAdded) {
      metrics.events.dlqAdded += dlq.totalAdded - lastDlqAdded;
    }
    if (dlq.totalRetries > lastDlqRetried) {
      metrics.events.dlqRetried += dlq.totalRetries - lastDlqRetried;
    }
    lastDlqAdded = dlq.totalAdded;
    lastDlqRetried = dlq.totalRetries;
    metrics.events.dlqExpired = dlq.totalExpired;

    // Track stale (estimated from recovery attempts)
    metrics.events.staleTasks = recovery.background + recovery.failed;

    // Update time series
    const currentSecond = Math.floor(Date.now() / 1000);
    if (currentSecond !== metrics.currentSecond) {
      metrics.throughputHistory.push(metrics.currentSecondSubmissions);
      metrics.failureHistory.push(metrics.currentSecondFailures);
      metrics.queueHistory.push(stats.tasks.queued);
      metrics.recoveryHistory.push(metrics.currentSecondRecoveries);

      // Keep last 30 seconds
      const maxLen = 30;
      if (metrics.throughputHistory.length > maxLen) metrics.throughputHistory.shift();
      if (metrics.failureHistory.length > maxLen) metrics.failureHistory.shift();
      if (metrics.queueHistory.length > maxLen) metrics.queueHistory.shift();
      if (metrics.recoveryHistory.length > maxLen) metrics.recoveryHistory.shift();

      metrics.currentSecondSubmissions = 0;
      metrics.currentSecondFailures = 0;
      metrics.currentSecondRecoveries = 0;
      metrics.currentSecond = currentSecond;
    }

    // Track backpressure rejections from guard stats
    const guard = stats.components.guard;
    const totalRejections = guard.admission.totals.rejected;
    if (totalRejections > metrics.events.backpressureRejections) {
      metrics.events.backpressureRejections = totalRejections;
    }

    // Render
    const dashboard = renderDashboard(stats, metrics);
    process.stdout.write(ANSI.cursorHome + dashboard);
  }, 100);

  // ═══════════════════════════════════════════════════════════════════════════════
  // Task Submission
  // ═══════════════════════════════════════════════════════════════════════════════

  const activeStreams = new Set<Promise<void>>();

  async function submitTask(behavior: 'normal' | 'fail' | 'slow' | 'checkpoint_fail' | 'poison') {
    const id = taskCounter++;
    taskBehaviors.set(id, behavior);

    const userIndex = Math.floor(Math.random() * 20);
    const user = `user-${userIndex}`;

    try {
      const task = await demoTask.run({
        input: { id },
        userId: userId(user),
        idempotencyKey: idempotencyKey(`task-${id}-${Date.now()}`)
      });

      metrics.tasksSubmitted++;
      metrics.currentSecondSubmissions++;

      // Stream events
      const streamPromise = (async () => {
        try {
          if (task.stream) {
            for await (const event of task.stream()) {
              if (event.type === 'error') {
                metrics.currentSecondFailures++;
              }
            }
          }
        } catch {
          // Stream closed
        }
      })();

      activeStreams.add(streamPromise);
      streamPromise.finally(() => activeStreams.delete(streamPromise));

    } catch {
      metrics.tasksRejected++;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // Scenario Runner
  // ═══════════════════════════════════════════════════════════════════════════════

  let running = true;

  async function runScenario(scenario: Scenario): Promise<void> {
    metrics.currentScenario = scenario;
    metrics.scenarioStartTime = Date.now();

    const cfg = SCENARIOS[scenario];
    let tasksSubmitted = 0;

    while (running && Date.now() - metrics.scenarioStartTime < config.scenarioDurationMs) {
      if (tasksSubmitted >= cfg.tasksToSubmit) {
        await sleep(100);
        continue;
      }

      // Determine task behavior based on scenario
      let behavior: 'normal' | 'fail' | 'slow' | 'checkpoint_fail' | 'poison' = 'normal';

      switch (scenario) {
        case 'baseline':
          behavior = 'normal';
          break;
        case 'burst':
          behavior = Math.random() < 0.15 ? 'fail' : 'normal'; // Some failures under load
          break;
        case 'failures':
          behavior = 'fail'; // High failure rate to trigger retries
          break;
        case 'hanging': // Now "SLOW" scenario
          behavior = 'slow'; // Slow tasks to fill queue
          break;
        case 'checkpoint':
          behavior = 'checkpoint_fail'; // Mixed checkpoint failures
          break;
        case 'dlq':
          behavior = 'poison'; // Always fail → exhaust retries
          break;
      }

      await submitTask(behavior);
      tasksSubmitted++;

      // Delay based on scenario
      const delay = cfg.submissionDelay.min +
        Math.random() * (cfg.submissionDelay.max - cfg.submissionDelay.min);
      await sleep(delay);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // Shutdown
  // ═══════════════════════════════════════════════════════════════════════════════

  const shutdown = async () => {
    running = false;
    metrics.currentScenario = 'drain';
    metrics.scenarioStartTime = Date.now();

    await Promise.race([
      Promise.all(activeStreams),
      sleep(3000)
    ]);

    await taskSystem.shutdown({ deleteFiles: true });
    clearInterval(renderInterval);
    console.log(ANSI.showCursor);

    // Final Report
    const stats = taskSystem.getStats();

    console.log('');
    console.log(color('╔══════════════════════════════════════════════════════════════════════════════╗', ANSI.cyan, ANSI.bold));
    console.log(color('║', ANSI.cyan) + color('                      📊 FINAL RELIABILITY REPORT                            ', ANSI.green, ANSI.bold) + color('║', ANSI.cyan));
    console.log(color('╠══════════════════════════════════════════════════════════════════════════════╣', ANSI.cyan));

    const elapsed = Date.now() - metrics.startTime;
    console.log(color('║', ANSI.cyan) + ` Duration: ${color(formatDuration(elapsed), ANSI.white, ANSI.bold)}   Submitted: ${metrics.tasksSubmitted}   Rejected: ${metrics.tasksRejected}`.padEnd(87) + color('║', ANSI.cyan));

    const successRate = stats.tasks.totalCompleted + stats.tasks.totalFailed > 0
      ? (stats.tasks.totalCompleted / (stats.tasks.totalCompleted + stats.tasks.totalFailed) * 100)
      : 0;
    console.log(color('║', ANSI.cyan) + ` Completed: ${color(stats.tasks.totalCompleted.toString(), ANSI.green)}   Failed: ${color(stats.tasks.totalFailed.toString(), ANSI.red)}   Success: ${color(successRate.toFixed(1) + '%', successRate >= 80 ? ANSI.green : ANSI.yellow)}`.padEnd(96) + color('║', ANSI.cyan));

    console.log(color('╠══════════════════════════════════════════════════════════════════════════════╣', ANSI.cyan));
    console.log(color('║', ANSI.cyan) + color(' FEATURES VERIFIED:', ANSI.yellow, ANSI.bold).padEnd(86) + color('║', ANSI.cyan));

    const check = (condition: boolean) => condition ? color('✓', ANSI.green) : color('○', ANSI.dim);

    console.log(color('║', ANSI.cyan) + `   ${check(metrics.events.backpressureRejections > 0)} Backpressure: ${metrics.events.backpressureRejections} tasks rejected under load`.padEnd(87) + color('║', ANSI.cyan));
    console.log(color('║', ANSI.cyan) + `   ${check(metrics.events.retriesSucceeded > 0)} Retry Success: ${metrics.events.retriesAttempted} attempts → ${metrics.events.retriesSucceeded} recovered`.padEnd(87) + color('║', ANSI.cyan));
    console.log(color('║', ANSI.cyan) + `   ${check(metrics.events.recoveredTasks > 0)} Stale Recovery: ${metrics.events.staleTasks} stale → ${metrics.events.recoveredTasks} recovered`.padEnd(87) + color('║', ANSI.cyan));
    console.log(color('║', ANSI.cyan) + `   ${check(metrics.events.checkpointRecoveries > 0)} Smart Recovery: ${metrics.events.checkpointRecoveries} resumed from checkpoint`.padEnd(87) + color('║', ANSI.cyan));
    console.log(color('║', ANSI.cyan) + `   ${check(metrics.events.dlqAdded > 0)} DLQ Management: ${metrics.events.dlqAdded} added → ${metrics.events.dlqRetried} retried`.padEnd(87) + color('║', ANSI.cyan));

    console.log(color('╠══════════════════════════════════════════════════════════════════════════════╣', ANSI.cyan));
    console.log(color('║', ANSI.cyan) + color(' PEAKS:', ANSI.yellow, ANSI.bold).padEnd(86) + color('║', ANSI.cyan));
    console.log(color('║', ANSI.cyan) + `   Queue: ${metrics.peakQueued}   Executing: ${metrics.peakExecuting}   DLQ: ${metrics.peakDLQ}`.padEnd(87) + color('║', ANSI.cyan));

    console.log(color('╚══════════════════════════════════════════════════════════════════════════════╝', ANSI.cyan, ANSI.bold));
    console.log('');

    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // ═══════════════════════════════════════════════════════════════════════════════
  // Run All Scenarios
  // ═══════════════════════════════════════════════════════════════════════════════

  const scenarioOrder: Scenario[] = ['baseline', 'burst', 'failures', 'hanging', 'checkpoint', 'dlq'];

  for (const scenario of scenarioOrder) {
    if (!running) break;
    await runScenario(scenario);

    // Small pause between scenarios
    if (running) await sleep(500);
  }

  // Wait for completion
  console.log(color('\n  All scenarios complete. Waiting for tasks to finish...', ANSI.dim));

  const completionTimeout = 30_000;
  const startWait = Date.now();

  while (running && Date.now() - startWait < completionTimeout) {
    const stats = taskSystem.getStats();
    if (stats.tasks.inFlight === 0) break;
    await sleep(500);
  }

  await shutdown();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.log(ANSI.showCursor);
  console.error('Demo error:', err);
  process.exit(1);
});
