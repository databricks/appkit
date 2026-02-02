/**
 * TaskFlow Interactive Demo
 *
 * Demonstrates TaskFlow with simulated LLM workloads:
 * - Default: 100 users × 20 tasks = 2000 total tasks
 * - Default concurrency: 100 slots (matches TaskFlow defaults, configurable via DEMO_MAX_CONCURRENT)
 *
 * NOTE: This demo simulates LLM latency with `await sleep()` - it does NOT
 * hit real backends. Real-world performance depends on your actual backend
 * constraints (LLM rate limits, SQL warehouse capacity, etc).
 *
 * Environment variables:
 *   DEMO_USERS=100            Number of simulated users
 *   DEMO_TASKS_PER_USER=20    Tasks per user
 *   DEMO_MAX_CONCURRENT=100   Max concurrent task executions
 *   DEMO_CHUNKS_MIN=10        Min streaming chunks per task
 *   DEMO_CHUNKS_MAX=25        Max streaming chunks per task
 *
 * Run with: npx tsx demo/interactive-demo.ts
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
  // Colors
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',

  // Foreground
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',

  // Background
  bgBlack: '\x1b[40m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgWhite: '\x1b[47m',

  // Cursor
  clearScreen: '\x1b[2J',
  cursorHome: '\x1b[H',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  clearLine: '\x1b[2K',
};

function color(text: string, ...codes: string[]): string {
  return codes.join('') + text + ANSI.reset;
}

function progressBar(value: number, max: number, width: number = 30): string {
  const pct = Math.min(1, Math.max(0, max > 0 ? value / max : 0));
  const filled = Math.round(pct * width);
  const empty = width - filled;

  let barColor = ANSI.green;
  if (pct > 0.8) barColor = ANSI.red;
  else if (pct > 0.6) barColor = ANSI.yellow;

  return `${barColor}${'█'.repeat(filled)}${ANSI.dim}${'░'.repeat(empty)}${ANSI.reset}`;
}

function sparkline(values: number[], width: number = 20): string {
  const chars = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  const recent = values.slice(-width);
  if (recent.length === 0) return '─'.repeat(width);

  const max = Math.max(...recent, 1);
  return recent.map(v => {
    const idx = Math.floor((v / max) * (chars.length - 1));
    return color(chars[idx], ANSI.cyan);
  }).join('');
}

function formatNumber(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toString();
}

function formatDuration(ms: number): string {
  if (ms >= 60000) return (ms / 60000).toFixed(1) + 'm';
  if (ms >= 1000) return (ms / 1000).toFixed(1) + 's';
  return ms.toFixed(0) + 'ms';
}

// ═══════════════════════════════════════════════════════════════════════════════
// Dashboard Renderer
// ═══════════════════════════════════════════════════════════════════════════════

interface DemoMetrics {
  // Simulation state
  totalTasks: number;
  tasksSubmitted: number;
  tasksRejected: number;
  totalUsers: number;
  startTime: number;

  // Per-user tracking
  userTaskCounts: Map<string, { submitted: number; completed: number; failed: number }>;

  // Time series for sparklines
  throughputHistory: number[];
  completionHistory: number[];
  dlqHistory: number[];
  executingHistory: number[];
  queuedHistory: number[];
  flushThroughputHistory: number[];

  // Current second counters
  currentSecondSubmissions: number;
  currentSecondCompletions: number;
  lastSecond: number;

  // Peak values
  peakQueued: number;
  peakExecuting: number;
  peakThroughput: number;
  peakCompletionRate: number;

  // Flush tracking
  lastFlushCount: number;
  lastEntriesFlushed: number;
  flushStartedAt: number | null;
  flushCompletedAt: number | null;
}

function renderDashboard(stats: TaskSystemStats, metrics: DemoMetrics): string {
  const lines: string[] = [];

  const elapsed = Date.now() - metrics.startTime;
  const throughput = elapsed > 0 ? (metrics.tasksSubmitted / (elapsed / 1000)).toFixed(1) : '0';
  const completionRate = elapsed > 0
    ? ((stats.tasks.totalCompleted + stats.tasks.totalFailed) / (elapsed / 1000)).toFixed(1)
    : '0';

  // Header
  lines.push('');
  lines.push(color('╔══════════════════════════════════════════════════════════════════════════════╗', ANSI.cyan, ANSI.bold));
  lines.push(color('║', ANSI.cyan) + color('                    🚀 TASKFLOW INTERACTIVE DEMO 🚀                         ', ANSI.yellow, ANSI.bold) + color('║', ANSI.cyan));
  lines.push(color('╠══════════════════════════════════════════════════════════════════════════════╣', ANSI.cyan));

  // System Status
  const statusColor = stats.system.status === 'running' ? ANSI.green : ANSI.yellow;
  lines.push(color('║', ANSI.cyan) + ` System: ${color(stats.system.status.toUpperCase(), statusColor, ANSI.bold)}    Uptime: ${color(formatDuration(stats.system.uptimeMs || 0), ANSI.white)}    Templates: ${color(stats.registry.templates.toString(), ANSI.white)}`.padEnd(87) + color('║', ANSI.cyan));
  lines.push(color('╠══════════════════════════════════════════════════════════════════════════════╣', ANSI.cyan));

  // Progress Section
  lines.push(color('║', ANSI.cyan) + color(' 📊 SIMULATION PROGRESS', ANSI.magenta, ANSI.bold).padEnd(86) + color('║', ANSI.cyan));
  lines.push(color('║', ANSI.cyan) + `   Tasks: ${color(metrics.tasksSubmitted.toString(), ANSI.green)}/${color(metrics.totalTasks.toString(), ANSI.white)} submitted   Waiting: ${color(stats.tasks.waiting.toString(), ANSI.yellow)}   Users: ${color(metrics.totalUsers.toString(), ANSI.cyan)}   Elapsed: ${color(formatDuration(elapsed), ANSI.yellow)}`.padEnd(87) + color('║', ANSI.cyan));

  const submissionProgress = progressBar(metrics.tasksSubmitted, metrics.totalTasks, 50);
  lines.push(color('║', ANSI.cyan) + `   Submissions: ${submissionProgress} ${((metrics.tasksSubmitted / metrics.totalTasks) * 100).toFixed(0)}%`.padEnd(87) + color('║', ANSI.cyan));

  const completedTotal = stats.tasks.totalCompleted + stats.tasks.totalFailed + stats.tasks.totalCancelled;
  const completionProgress = progressBar(completedTotal, metrics.tasksSubmitted, 50);
  lines.push(color('║', ANSI.cyan) + `   Completions: ${completionProgress} ${metrics.tasksSubmitted > 0 ? ((completedTotal / metrics.tasksSubmitted) * 100).toFixed(0) : 0}%`.padEnd(87) + color('║', ANSI.cyan));

  lines.push(color('╠══════════════════════════════════════════════════════════════════════════════╣', ANSI.cyan));

  // Task Metrics
  lines.push(color('║', ANSI.cyan) + color(' 📈 TASK METRICS', ANSI.magenta, ANSI.bold).padEnd(86) + color('║', ANSI.cyan));
  lines.push(color('║', ANSI.cyan) + `   ${color('Queued:', ANSI.dim)} ${color(stats.tasks.queued.toString().padStart(5), ANSI.yellow)}   ${color('Waiting:', ANSI.dim)} ${color(stats.tasks.waiting.toString().padStart(5), ANSI.yellow)}   ${color('Executing:', ANSI.dim)} ${color(stats.tasks.executing.toString().padStart(5), ANSI.cyan)}   ${color('In-Flight:', ANSI.dim)} ${color(stats.tasks.inFlight.toString().padStart(5), ANSI.white)}`.padEnd(96) + color('║', ANSI.cyan));
  lines.push(color('║', ANSI.cyan) + `   ${color('Completed:', ANSI.dim)} ${color(stats.tasks.totalCompleted.toString().padStart(5), ANSI.green)}   ${color('Failed:', ANSI.dim)} ${color(stats.tasks.totalFailed.toString().padStart(5), ANSI.red)}   ${color('Cancelled:', ANSI.dim)} ${color(stats.tasks.totalCancelled.toString().padStart(5), ANSI.yellow)}   ${color('Success:', ANSI.dim)} ${color(((stats.tasks.successRate || 0) * 100).toFixed(1) + '%', ANSI.green)}`.padEnd(96) + color('║', ANSI.cyan));

  // Throughput sparklines
  lines.push(color('║', ANSI.cyan) + `   Throughput/s: ${sparkline(metrics.throughputHistory, 40)} ${color(throughput + '/s', ANSI.cyan)}`.padEnd(96) + color('║', ANSI.cyan));
  lines.push(color('║', ANSI.cyan) + `   Completed/s:  ${sparkline(metrics.completionHistory, 40)} ${color(completionRate + '/s', ANSI.green)}`.padEnd(96) + color('║', ANSI.cyan));

  lines.push(color('╠══════════════════════════════════════════════════════════════════════════════╣', ANSI.cyan));

  // Guard System
  const guard = stats.components.guard;
  lines.push(color('║', ANSI.cyan) + color(' 🛡️  GUARD SYSTEM (Rate Limiting & Admission Control)', ANSI.magenta, ANSI.bold).padEnd(86) + color('║', ANSI.cyan));

  // Backpressure
  const admission = guard.admission;
  const windowPct = admission.config.maxTasksPerWindow > 0
    ? (admission.window.accepted / admission.config.maxTasksPerWindow * 100).toFixed(0)
    : '0';
  lines.push(color('║', ANSI.cyan) + `   ${color('Backpressure:', ANSI.bold)} Window ${color(admission.window.accepted.toString(), ANSI.green)}/${color(admission.config.maxTasksPerWindow.toString(), ANSI.white)} (${windowPct}%)   Rejected: ${color(admission.window.rejected.toString(), ANSI.red)}`.padEnd(96) + color('║', ANSI.cyan));

  // Slots
  const slots = guard.slots;
  const slotsBar = progressBar(slots.current.inUse, slots.limits.global, 20);
  lines.push(color('║', ANSI.cyan) + `   ${color('Exec Slots:', ANSI.bold)}   ${slotsBar} ${color(slots.current.inUse.toString(), ANSI.cyan)}/${color(slots.limits.global.toString(), ANSI.white)} in use   Waiting: ${color(slots.current.waiting.toString(), ANSI.yellow)}`.padEnd(96) + color('║', ANSI.cyan));

  // DLQ
  const dlq = guard.dlq;
  const dlqBar = progressBar(dlq.size, 100, 20);
  lines.push(color('║', ANSI.cyan) + `   ${color('DLQ:', ANSI.bold)}          ${dlqBar} ${color(dlq.size.toString(), dlq.size > 0 ? ANSI.red : ANSI.green)} entries   Retries: ${color(dlq.totalRetries.toString(), ANSI.yellow)}   Expired: ${color(dlq.totalExpired.toString(), ANSI.dim)}`.padEnd(96) + color('║', ANSI.cyan));
  lines.push(color('║', ANSI.cyan) + `   DLQ Trend:    ${sparkline(metrics.dlqHistory, 40)}`.padEnd(87) + color('║', ANSI.cyan));

  lines.push(color('╠══════════════════════════════════════════════════════════════════════════════╣', ANSI.cyan));

  // Executor Stats
  const executor = stats.components.executor;
  lines.push(color('║', ANSI.cyan) + color(' ⚡ EXECUTOR', ANSI.magenta, ANSI.bold).padEnd(86) + color('║', ANSI.cyan));
  lines.push(color('║', ANSI.cyan) + `   Executing: ${color(executor.current.executing.toString(), ANSI.cyan)}   Heartbeats: ${color(executor.current.heartbeatsActive.toString(), ANSI.dim)}   Handler Missing: ${color(executor.outcomes.handlerMissing.toString(), ANSI.red)}`.padEnd(96) + color('║', ANSI.cyan));
  lines.push(color('║', ANSI.cyan) + `   Retries: Attempted ${color(executor.retries.attempted.toString(), ANSI.yellow)} / Succeeded ${color(executor.retries.succeeded.toString(), ANSI.green)} / Exhausted ${color(executor.retries.exhausted.toString(), ANSI.red)}`.padEnd(96) + color('║', ANSI.cyan));

  lines.push(color('╠══════════════════════════════════════════════════════════════════════════════╣', ANSI.cyan));

  // Stream Stats
  const stream = stats.components.stream;
  lines.push(color('║', ANSI.cyan) + color(' 📡 STREAMING', ANSI.magenta, ANSI.bold).padEnd(86) + color('║', ANSI.cyan));
  lines.push(color('║', ANSI.cyan) + `   Active Streams: ${color(stream.streams.active.toString(), ANSI.cyan)}   Listeners: ${color(stream.listeners.total.toString(), ANSI.white)}   Events Pushed: ${color(formatNumber(stream.events.pushed), ANSI.green)}`.padEnd(96) + color('║', ANSI.cyan));
  lines.push(color('║', ANSI.cyan) + `   Buffer Events: ${color(stream.buffer.totalEvents.toString(), ANSI.yellow)}   Overflows: ${color(stream.buffer.overflows.toString(), stream.buffer.overflows > 0 ? ANSI.red : ANSI.green)}`.padEnd(96) + color('║', ANSI.cyan));

  lines.push(color('╠══════════════════════════════════════════════════════════════════════════════╣', ANSI.cyan));

  // WAL (Event Log) Stats
  const eventLog = stats.components.eventLog;
  lines.push(color('║', ANSI.cyan) + color(' 📝 WAL (Event Log)', ANSI.magenta, ANSI.bold).padEnd(86) + color('║', ANSI.cyan));
  lines.push(color('║', ANSI.cyan) + `   Current Seq: ${color(eventLog.sequence.current.toString(), ANSI.cyan)}   Total Writes: ${color(formatNumber(eventLog.volume.entriesWritten), ANSI.green)}   Rotations: ${color(eventLog.rotation.count.toString(), ANSI.yellow)}`.padEnd(96) + color('║', ANSI.cyan));

  lines.push(color('╠══════════════════════════════════════════════════════════════════════════════╣', ANSI.cyan));

  // Flush Stats
  const flush = stats.components.flush;
  const walWrites = stats.components.eventLog.volume.entriesWritten;
  lines.push(color('║', ANSI.cyan) + color(' 💾 FLUSH (Persistence)', ANSI.magenta, ANSI.bold).padEnd(86) + color('║', ANSI.cyan));
  if (flush.worker) {
    const flushPct = walWrites > 0 ? ((flush.worker.totalEntriesFlushed / walWrites) * 100).toFixed(0) : '0';
    const flushThroughput = metrics.flushThroughputHistory.length > 0
      ? metrics.flushThroughputHistory[metrics.flushThroughputHistory.length - 1]
      : 0;
    lines.push(color('║', ANSI.cyan) + `   Flushed: ${color(formatNumber(flush.worker.totalEntriesFlushed), ANSI.green)}/${color(formatNumber(walWrites), ANSI.white)} (${flushPct}%)   Throughput: ${color(flushThroughput + '/s', ANSI.cyan)}   Errors: ${color(flush.worker.errorCount.toString(), flush.worker.errorCount > 0 ? ANSI.red : ANSI.green)}`.padEnd(96) + color('║', ANSI.cyan));
    lines.push(color('║', ANSI.cyan) + `   Flush Rate: ${sparkline(metrics.flushThroughputHistory, 40)}`.padEnd(87) + color('║', ANSI.cyan));
    if (flush.worker.lastError) {
      lines.push(color('║', ANSI.cyan) + `   ${color('Error:', ANSI.red)} ${color(flush.worker.lastError.substring(0, 60), ANSI.dim)}`.padEnd(96) + color('║', ANSI.cyan));
    }
  } else {
    lines.push(color('║', ANSI.cyan) + `   ${color('Worker not running (stats pending...)', ANSI.yellow)}`.padEnd(87) + color('║', ANSI.cyan));
  }

  lines.push(color('╠══════════════════════════════════════════════════════════════════════════════╣', ANSI.cyan));

  // User Distribution (top 5)
  lines.push(color('║', ANSI.cyan) + color(' 👥 USER DISTRIBUTION (Top 5)', ANSI.magenta, ANSI.bold).padEnd(86) + color('║', ANSI.cyan));

  const sortedUsers = Array.from(metrics.userTaskCounts.entries())
    .sort((a, b) => b[1].submitted - a[1].submitted)
    .slice(0, 5);

  for (const [user, counts] of sortedUsers) {
    const userBar = progressBar(counts.completed + counts.failed, counts.submitted, 15);
    const userNum = user.replace('user-', '').padStart(2, '0');
    lines.push(color('║', ANSI.cyan) + `   User ${color(userNum, ANSI.cyan)}: ${userBar} S:${color(counts.submitted.toString().padStart(3), ANSI.white)} C:${color(counts.completed.toString().padStart(3), ANSI.green)} F:${color(counts.failed.toString().padStart(3), ANSI.red)}`.padEnd(96) + color('║', ANSI.cyan));
  }

  lines.push(color('╠══════════════════════════════════════════════════════════════════════════════╣', ANSI.cyan));

  // Rejection Reasons
  const rejections = admission.rejections.byReason;
  lines.push(color('║', ANSI.cyan) + color(' ⚠️  REJECTION BREAKDOWN', ANSI.magenta, ANSI.bold).padEnd(86) + color('║', ANSI.cyan));
  lines.push(color('║', ANSI.cyan) + `   Global Rate: ${color((rejections.global_rate_limit || 0).toString(), ANSI.red)}   User Rate: ${color((rejections.user_rate_limit || 0).toString(), ANSI.red)}   Queue Full: ${color((rejections.queue_full || 0).toString(), ANSI.red)}   In DLQ: ${color((rejections.in_dlq || 0).toString(), ANSI.yellow)}`.padEnd(96) + color('║', ANSI.cyan));

  lines.push(color('╚══════════════════════════════════════════════════════════════════════════════╝', ANSI.cyan, ANSI.bold));
  lines.push('');

  // Show different hint based on system status
  if (stats.system.status === 'shutting_down') {
    lines.push(color('  ⏳ Graceful shutdown in progress - flushing remaining events to database...', ANSI.yellow));
  } else {
    lines.push(color('  Press Ctrl+C to stop the demo', ANSI.dim));
  }

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Demo Configuration (Environment Variables)
// ═══════════════════════════════════════════════════════════════════════════════

interface DemoConfig {
  /** Number of simulated users */
  users: number;
  /** Tasks per user */
  tasksPerUser: number;
  /** Streaming chunks (events) per task */
  chunksPerTask: { min: number; max: number };
  /** Maximum concurrent task executions */
  maxConcurrent: number;
}

function loadConfig(): DemoConfig {
  return {
    users: parseInt(process.env.DEMO_USERS ?? '100', 10),
    tasksPerUser: parseInt(process.env.DEMO_TASKS_PER_USER ?? '20', 10),
    chunksPerTask: {
      min: parseInt(process.env.DEMO_CHUNKS_MIN ?? '10', 10),
      max: parseInt(process.env.DEMO_CHUNKS_MAX ?? '25', 10),
    },
    maxConcurrent: parseInt(process.env.DEMO_MAX_CONCURRENT ?? '100', 10),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Demo Application
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  // Load configuration from environment
  const config = loadConfig();
  const totalTasks = config.users * config.tasksPerUser;

  console.log(ANSI.clearScreen + ANSI.cursorHome + ANSI.hideCursor);
  console.log(color('\n  Initializing TaskFlow...', ANSI.cyan, ANSI.bold));
  console.log(color(`  Config: ${config.users} users × ${config.tasksPerUser} tasks = ${totalTasks} total`, ANSI.dim));
  console.log(color(`  Concurrency: ${config.maxConcurrent} | Chunks/task: ${config.chunksPerTask.min}-${config.chunksPerTask.max}`, ANSI.dim));

  // Demo data directory
  const demoDir = './.taskflow-demo';

  // Ensure demo directory exists
  const { mkdir, rm } = await import('node:fs/promises');
  await rm(demoDir, { recursive: true, force: true });
  await mkdir(demoDir, { recursive: true });

  // Initialize TaskSystem with demo configuration
  const maxQueueSize = Math.max(5000, totalTasks);

  const taskSystem = new TaskSystem({
    repository: {
      type: 'sqlite',
      database: `${demoDir}/demo.db`
    },
    eventLog: {
      eventLogPath: `${demoDir}/event.log`,
      maxSizeBytesPerFile: 10_485_760,
      maxAgePerFile: 3_600_000,
      retentionCount: 3
    },
    guard: {
      backpressure: {
        windowSizeMs: 60_000,
        maxTasksPerWindow: Math.max(5000, totalTasks),
        maxTasksPerUserWindow: Math.max(100, config.tasksPerUser * 2),
        maxQueuedSize: maxQueueSize
      },
      slots: {
        maxExecutionGlobal: config.maxConcurrent,
        maxExecutionPerUser: 10,        // 10 per user
        slotTimeoutMs: 60_000           // 60 second timeout
      },
      dlq: {
        maxSize: 200,
        ttlMs: 60_000,                  // 1 minute for demo
        cleanupIntervalMs: 5_000,
        maxRetries: 2
      },
      recovery: {
        maxRecoverySlots: 5,
        recoverySlotTimeoutMs: 30_000
      }
    },
    executor: {
      heartbeatIntervalMs: 5_000,
      retry: {
        maxAttempts: 3,
        initialDelayMs: 500,
        maxDelayMs: 5_000,
        backoffMultiplier: 2
      }
    },
    flush: {
      eventLogPath: `${demoDir}/event.log`,
      // Use defaults for dynamic batch sizing (500-5000) and 100ms interval
    },
    recovery: {
      enabled: true,
      backgroundPollIntervalMs: 10_000,
      staleThresholdMs: 30_000,
      batchSize: 5,
      completionTimeoutMs: 30_000,
      heartbeatIntervalMs: 5_000
    },
    shutdown: {
      gracePeriodMs: 5_000,
      pollIntervalMs: 100
    }
  });

  await taskSystem.initialize();
  console.log(color('  TaskFlow initialized!', ANSI.green, ANSI.bold));

  // ═══════════════════════════════════════════════════════════════════════════════
  // OpenAI-like LLM Task Simulation
  // ═══════════════════════════════════════════════════════════════════════════════

  // Configuration matching realistic OpenAI behavior
  const LLM_CONFIG = {
    minLatencyMs: 800,      // Minimum response latency
    maxLatencyMs: 5000,     // Maximum response latency
    failureRate: 0.02,      // 2% random failure rate
    timeoutRate: 0.01,      // 1% random timeout rate
    chunksMin: config.chunksPerTask.min,   // From env: DEMO_CHUNKS_MIN
    chunksMax: config.chunksPerTask.max,   // From env: DEMO_CHUNKS_MAX
    tokensPerChunk: 15,     // Approximate tokens per chunk
  };

  // Register the "LLM-Agent" task (simulates OpenAI chat completion)
  const agentTask = taskSystem.registerTask({
    name: 'LLM-Agent',
    description: 'Simulated LLM agent with realistic OpenAI-like latency, streaming, and failure rates',
    type: 'user',

    handler: async function* (input: { workId: number; prompt: string; complexity: number }, _context: TaskHandlerContext) {
      const { workId, prompt, complexity } = input;

      // Simulate random failures (2% rate) - happens before streaming starts
      if (Math.random() < LLM_CONFIG.failureRate) {
        throw new Error(`LLM service error: Rate limit exceeded or service unavailable (work #${workId})`);
      }

      // Simulate random timeouts (1% rate)
      if (Math.random() < LLM_CONFIG.timeoutRate) {
        throw new Error(`Request timeout: LLM service took too long to respond (work #${workId})`);
      }

      // Calculate realistic latency based on input complexity
      // Latency = minLatency + (complexity/maxComplexity) * (maxLatency - minLatency) + random jitter
      const inputLength = prompt.length;
      const normalizedComplexity = Math.min(inputLength, 2000) / 2000;
      const variableLatency = normalizedComplexity * (LLM_CONFIG.maxLatencyMs - LLM_CONFIG.minLatencyMs);
      const totalLatency = LLM_CONFIG.minLatencyMs + variableLatency + (Math.random() * 1000 * complexity);

      // Determine number of streaming chunks
      const numChunks = LLM_CONFIG.chunksMin + Math.floor(Math.random() * (LLM_CONFIG.chunksMax - LLM_CONFIG.chunksMin));
      const chunkDelay = totalLatency / numChunks;

      // Initial role chunk (like OpenAI's first chunk)
      yield {
        type: 'progress',
        message: 'LLM started',
        payload: {
          role: 'assistant',
          chunkIndex: 0,
          totalChunks: numChunks,
          tokensGenerated: 0,
          progress: 0
        }
      };

      // Intro chunks
      const introChunks = [
        "I understand your question.",
        " Let me think about this step by step.",
        " "
      ];

      for (let i = 0; i < introChunks.length; i++) {
        await sleep(chunkDelay);
        yield {
          type: 'progress',
          message: introChunks[i],
          payload: {
            content: introChunks[i],
            chunkIndex: i + 1,
            totalChunks: numChunks,
            tokensGenerated: (i + 1) * LLM_CONFIG.tokensPerChunk,
            progress: Math.min(95, ((i + 1) / numChunks) * 100)
          }
        };
      }

      // Content chunks (main response)
      const remainingChunks = numChunks - introChunks.length - 1; // -1 for final chunk
      for (let i = 0; i < remainingChunks; i++) {
        await sleep(chunkDelay);

        // Simulate small chance of mid-stream failure (0.5%)
        if (Math.random() < 0.005) {
          throw new Error(`LLM stream interrupted: Connection reset (work #${workId})`);
        }

        const chunkIndex = introChunks.length + i + 1;
        yield {
          type: 'progress',
          message: `Generating response...`,
          payload: {
            content: `[chunk ${i + 1}/${remainingChunks}]`,
            chunkIndex,
            totalChunks: numChunks,
            tokensGenerated: chunkIndex * LLM_CONFIG.tokensPerChunk,
            progress: Math.min(95, (chunkIndex / numChunks) * 100)
          }
        };
      }

      // Final chunk (completion)
      await sleep(chunkDelay);
      const totalTokens = numChunks * LLM_CONFIG.tokensPerChunk;

      yield {
        type: 'progress',
        message: 'Generation complete',
        payload: {
          finishReason: 'stop',
          chunkIndex: numChunks,
          totalChunks: numChunks,
          tokensGenerated: totalTokens,
          progress: 100
        }
      };

      return {
        workId,
        model: 'gpt-4-mock',
        usage: {
          promptTokens: Math.floor(prompt.length / 4),
          completionTokens: totalTokens,
          totalTokens: Math.floor(prompt.length / 4) + totalTokens
        },
        finishReason: 'stop',
        latencyMs: totalLatency,
        processedAt: Date.now()
      };
    },

    recover: async function* (input: { workId: number; prompt: string; complexity: number }, ctx: RecoveryContext) {
      // Check last progress to determine recovery point
      const lastProgress = ctx.previousEvents
        .filter((e: { type: string }) => e.type === 'progress')
        .pop();

      const lastChunk = (lastProgress?.payload?.chunkIndex as number) ?? 0;
      const totalChunks = (lastProgress?.payload?.totalChunks as number) ?? 20;

      if (lastProgress?.payload?.finishReason === 'stop') {
        yield { type: 'recovered', message: 'Already completed, returning cached result' };
        return { workId: input.workId, result: 'Recovered from completion', processedAt: Date.now() };
      }

      yield { type: 'recovered', message: `Resuming from chunk ${lastChunk}/${totalChunks}` };

      // Complete remaining chunks
      const remainingChunks = totalChunks - lastChunk;
      for (let i = 0; i < remainingChunks; i++) {
        await sleep(100 + Math.random() * 200);
        yield {
          type: 'progress',
          message: 'Recovered chunk',
          payload: {
            chunkIndex: lastChunk + i + 1,
            totalChunks,
            tokensGenerated: (lastChunk + i + 1) * 15,
            progress: Math.min(100, ((lastChunk + i + 1) / totalChunks) * 100)
          }
        };
      }

      return { workId: input.workId, result: 'Recovered', processedAt: Date.now() };
    }
  });

  // Demo metrics
  const metrics: DemoMetrics = {
    totalTasks,
    tasksSubmitted: 0,
    tasksRejected: 0,
    totalUsers: config.users,
    startTime: Date.now(),
    userTaskCounts: new Map(),
    throughputHistory: [],
    completionHistory: [],
    dlqHistory: [],
    executingHistory: [],
    queuedHistory: [],
    flushThroughputHistory: [],
    currentSecondSubmissions: 0,
    currentSecondCompletions: 0,
    lastSecond: Math.floor(Date.now() / 1000),
    peakQueued: 0,
    peakExecuting: 0,
    peakThroughput: 0,
    peakCompletionRate: 0,
    lastFlushCount: 0,
    lastEntriesFlushed: 0,
    flushStartedAt: null,
    flushCompletedAt: null
  };

  // Initialize user tracking
  for (let i = 0; i < config.users; i++) {
    metrics.userTaskCounts.set(`user-${i}`, { submitted: 0, completed: 0, failed: 0 });
  }

  // Track task completions
  const activeStreams = new Set<Promise<void>>();

  // Render loop
  let running = true;
  const renderInterval = setInterval(() => {
    const stats = taskSystem.getStats();

    // Track peak values
    if (stats.tasks.queued > metrics.peakQueued) {
      metrics.peakQueued = stats.tasks.queued;
    }
    if (stats.tasks.executing > metrics.peakExecuting) {
      metrics.peakExecuting = stats.tasks.executing;
    }

    // Update time series
    const currentSecond = Math.floor(Date.now() / 1000);
    if (currentSecond !== metrics.lastSecond) {
      metrics.throughputHistory.push(metrics.currentSecondSubmissions);
      metrics.completionHistory.push(metrics.currentSecondCompletions);
      metrics.dlqHistory.push(stats.components.guard.dlq.size);
      metrics.executingHistory.push(stats.tasks.executing);
      metrics.queuedHistory.push(stats.tasks.queued);

      // Track flush throughput (entries flushed per second)
      const currentFlushed = stats.components.flush.worker?.totalEntriesFlushed ?? 0;
      const flushDelta = currentFlushed - metrics.lastEntriesFlushed;
      metrics.flushThroughputHistory.push(flushDelta);
      metrics.lastEntriesFlushed = currentFlushed;

      // Track peak rates
      if (metrics.currentSecondSubmissions > metrics.peakThroughput) {
        metrics.peakThroughput = metrics.currentSecondSubmissions;
      }
      if (metrics.currentSecondCompletions > metrics.peakCompletionRate) {
        metrics.peakCompletionRate = metrics.currentSecondCompletions;
      }

      // Keep only last 60 seconds
      if (metrics.throughputHistory.length > 60) metrics.throughputHistory.shift();
      if (metrics.completionHistory.length > 60) metrics.completionHistory.shift();
      if (metrics.dlqHistory.length > 60) metrics.dlqHistory.shift();
      if (metrics.executingHistory.length > 60) metrics.executingHistory.shift();
      if (metrics.queuedHistory.length > 60) metrics.queuedHistory.shift();
      if (metrics.flushThroughputHistory.length > 60) metrics.flushThroughputHistory.shift();

      metrics.currentSecondSubmissions = 0;
      metrics.currentSecondCompletions = 0;
      metrics.lastSecond = currentSecond;
    }

    // Render dashboard
    const dashboard = renderDashboard(stats, metrics);
    process.stdout.write(ANSI.cursorHome + dashboard);
  }, 100);

  // Submit tasks from multiple users
  async function submitTask(userIndex: number, taskIndex: number) {
    const user = `user-${userIndex}`;
    const userStats = metrics.userTaskCounts.get(user);
    if (!userStats) return;

    try {
      // Generate a realistic prompt (varying length affects latency)
      const prompts = [
        "Explain the key concepts of machine learning in simple terms.",
        "Write a Python function to calculate the Fibonacci sequence with memoization and explain how it works step by step.",
        "What are the best practices for building scalable microservices architecture? Include considerations for fault tolerance and observability.",
        "Summarize the main differences between SQL and NoSQL databases.",
        "Help me debug this code that's causing a memory leak in my Node.js application. I'm seeing high memory usage over time.",
      ];
      const prompt = prompts[taskIndex % prompts.length];

      const task = await agentTask.run({
        input: {
          workId: taskIndex,
          prompt,
          complexity: 1 + Math.random() * 2 // Random complexity 1-3 (affects latency jitter)
        },
        userId: userId(user),
        idempotencyKey: idempotencyKey(`llm-${user}-${taskIndex}-${Date.now()}`)
      });

      userStats.submitted++;
      metrics.tasksSubmitted++;
      metrics.currentSecondSubmissions++;

      // Stream events in background
      const streamPromise = (async () => {
        try {
          if (task.stream) {
            for await (const event of task.stream()) {
              if (event.type === 'complete') {
                userStats.completed++;
                metrics.currentSecondCompletions++;
              } else if (event.type === 'error') {
                userStats.failed++;
                metrics.currentSecondCompletions++;
              }
            }
          }
        } catch {
          // Stream closed, ignore
        }
      })();

      activeStreams.add(streamPromise);
      streamPromise.finally(() => activeStreams.delete(streamPromise));

    } catch {
      // Task rejected (backpressure, etc.)
      metrics.tasksRejected++;
    }
  }

  // Simulate users submitting tasks
  const userPromises: Promise<void>[] = [];

  for (let userIndex = 0; userIndex < config.users; userIndex++) {
    const userPromise = (async () => {
      for (let taskNum = 0; taskNum < config.tasksPerUser && metrics.tasksSubmitted < totalTasks; taskNum++) {
        if (!running) break;

        const taskIndex = userIndex * config.tasksPerUser + taskNum;
        if (taskIndex >= totalTasks) break;

        await submitTask(userIndex, taskIndex);

        // Stagger submissions - slower rate to sustain pressure over time
        const delay = 50 + Math.random() * 100; // 50-150ms between submissions per user
        await sleep(delay);
      }
    })();

    userPromises.push(userPromise);
  }

  // Handle shutdown
  const shutdown = async () => {
    running = false;

    // Wait for active streams to complete (with timeout)
    await Promise.race([
      Promise.all(activeStreams),
      sleep(2000)
    ]);

    // Track flush timing
    const flushStartTime = Date.now();

    // Keep dashboard updating during shutdown to show flush progress
    await taskSystem.shutdown({ deleteFiles: true });

    // Calculate how long graceful shutdown flush took
    metrics.flushStartedAt = flushStartTime;
    metrics.flushCompletedAt = Date.now();

    // Now stop the render interval after shutdown is complete
    clearInterval(renderInterval);
    console.log(ANSI.showCursor);

    // Final stats
    const finalStats = taskSystem.getStats();
    const totalDurationMs = Date.now() - metrics.startTime;
    const totalDurationS = totalDurationMs / 1000;

    const totalProcessed = finalStats.tasks.totalCompleted + finalStats.tasks.totalFailed;
    const successRate = totalProcessed > 0 ? (finalStats.tasks.totalCompleted / totalProcessed) * 100 : 0;
    const errorRate = totalProcessed > 0 ? (finalStats.tasks.totalFailed / totalProcessed) * 100 : 0;

    const avgThroughput = totalDurationS > 0 ? metrics.tasksSubmitted / totalDurationS : 0;
    const avgCompletionRate = totalDurationS > 0 ? totalProcessed / totalDurationS : 0;

    // Calculate averages from history
    const avgExecuting = metrics.executingHistory.length > 0
      ? metrics.executingHistory.reduce((a, b) => a + b, 0) / metrics.executingHistory.length
      : 0;
    const avgQueued = metrics.queuedHistory.length > 0
      ? metrics.queuedHistory.reduce((a, b) => a + b, 0) / metrics.queuedHistory.length
      : 0;

    console.log('');
    console.log(color('╔══════════════════════════════════════════════════════════════════════════════╗', ANSI.cyan, ANSI.bold));
    console.log(color('║', ANSI.cyan) + color('                         📊 FINAL PERFORMANCE REPORT                         ', ANSI.green, ANSI.bold) + color('║', ANSI.cyan));
    console.log(color('╠══════════════════════════════════════════════════════════════════════════════╣', ANSI.cyan));

    // Duration
    console.log(color('║', ANSI.cyan) + color(' ⏱️  DURATION', ANSI.yellow, ANSI.bold).padEnd(86) + color('║', ANSI.cyan));
    console.log(color('║', ANSI.cyan) + `   Total Runtime:        ${color(formatDuration(totalDurationMs), ANSI.white, ANSI.bold)}`.padEnd(87) + color('║', ANSI.cyan));

    console.log(color('╠══════════════════════════════════════════════════════════════════════════════╣', ANSI.cyan));

    // Task Summary
    console.log(color('║', ANSI.cyan) + color(' 📋 TASK SUMMARY', ANSI.yellow, ANSI.bold).padEnd(86) + color('║', ANSI.cyan));
    console.log(color('║', ANSI.cyan) + `   Total Attempted:      ${color(String(metrics.tasksSubmitted + metrics.tasksRejected), ANSI.white)}`.padEnd(87) + color('║', ANSI.cyan));
    console.log(color('║', ANSI.cyan) + `   Successfully Queued:  ${color(String(metrics.tasksSubmitted), ANSI.green)}`.padEnd(87) + color('║', ANSI.cyan));
    console.log(color('║', ANSI.cyan) + `   Rejected (Backpres.): ${color(String(metrics.tasksRejected), ANSI.red)}`.padEnd(87) + color('║', ANSI.cyan));
    console.log(color('║', ANSI.cyan) + `   Completed:            ${color(String(finalStats.tasks.totalCompleted), ANSI.green)}`.padEnd(87) + color('║', ANSI.cyan));
    console.log(color('║', ANSI.cyan) + `   Failed:               ${color(String(finalStats.tasks.totalFailed), ANSI.red)}`.padEnd(87) + color('║', ANSI.cyan));
    console.log(color('║', ANSI.cyan) + `   Cancelled:            ${color(String(finalStats.tasks.totalCancelled), ANSI.yellow)}`.padEnd(87) + color('║', ANSI.cyan));

    console.log(color('╠══════════════════════════════════════════════════════════════════════════════╣', ANSI.cyan));

    // Success/Error Rates
    console.log(color('║', ANSI.cyan) + color(' ✅ SUCCESS & ERROR RATES', ANSI.yellow, ANSI.bold).padEnd(86) + color('║', ANSI.cyan));
    const successColor = successRate >= 95 ? ANSI.green : successRate >= 80 ? ANSI.yellow : ANSI.red;
    const errorColor = errorRate <= 5 ? ANSI.green : errorRate <= 20 ? ANSI.yellow : ANSI.red;
    console.log(color('║', ANSI.cyan) + `   Success Rate:         ${color(successRate.toFixed(2) + '%', successColor, ANSI.bold)}`.padEnd(87) + color('║', ANSI.cyan));
    console.log(color('║', ANSI.cyan) + `   Error Rate:           ${color(errorRate.toFixed(2) + '%', errorColor)}`.padEnd(87) + color('║', ANSI.cyan));
    console.log(color('║', ANSI.cyan) + `   Acceptance Rate:      ${color(((metrics.tasksSubmitted / (metrics.tasksSubmitted + metrics.tasksRejected)) * 100).toFixed(2) + '%', ANSI.white)}`.padEnd(87) + color('║', ANSI.cyan));

    console.log(color('╠══════════════════════════════════════════════════════════════════════════════╣', ANSI.cyan));

    // Throughput
    console.log(color('║', ANSI.cyan) + color(' 🚀 THROUGHPUT', ANSI.yellow, ANSI.bold).padEnd(86) + color('║', ANSI.cyan));
    console.log(color('║', ANSI.cyan) + `   Avg Submission Rate:  ${color(avgThroughput.toFixed(1) + ' tasks/s', ANSI.cyan)}`.padEnd(87) + color('║', ANSI.cyan));
    console.log(color('║', ANSI.cyan) + `   Avg Completion Rate:  ${color(avgCompletionRate.toFixed(1) + ' tasks/s', ANSI.green)}`.padEnd(87) + color('║', ANSI.cyan));
    console.log(color('║', ANSI.cyan) + `   Peak Submission Rate: ${color(metrics.peakThroughput + ' tasks/s', ANSI.cyan, ANSI.bold)}`.padEnd(87) + color('║', ANSI.cyan));
    console.log(color('║', ANSI.cyan) + `   Peak Completion Rate: ${color(metrics.peakCompletionRate + ' tasks/s', ANSI.green, ANSI.bold)}`.padEnd(87) + color('║', ANSI.cyan));

    console.log(color('╠══════════════════════════════════════════════════════════════════════════════╣', ANSI.cyan));

    // Concurrency
    console.log(color('║', ANSI.cyan) + color(' ⚡ CONCURRENCY', ANSI.yellow, ANSI.bold).padEnd(86) + color('║', ANSI.cyan));
    console.log(color('║', ANSI.cyan) + `   Peak Executing:       ${color(String(metrics.peakExecuting), ANSI.cyan, ANSI.bold)}`.padEnd(87) + color('║', ANSI.cyan));
    console.log(color('║', ANSI.cyan) + `   Avg Executing:        ${color(avgExecuting.toFixed(1), ANSI.cyan)}`.padEnd(87) + color('║', ANSI.cyan));
    console.log(color('║', ANSI.cyan) + `   Peak Queued:          ${color(String(metrics.peakQueued), ANSI.yellow, ANSI.bold)}`.padEnd(87) + color('║', ANSI.cyan));
    console.log(color('║', ANSI.cyan) + `   Avg Queued:           ${color(avgQueued.toFixed(1), ANSI.yellow)}`.padEnd(87) + color('║', ANSI.cyan));

    console.log(color('╠══════════════════════════════════════════════════════════════════════════════╣', ANSI.cyan));

    // Guard System
    const guard = finalStats.components.guard;
    console.log(color('║', ANSI.cyan) + color(' 🛡️  GUARD SYSTEM', ANSI.yellow, ANSI.bold).padEnd(86) + color('║', ANSI.cyan));
    console.log(color('║', ANSI.cyan) + `   Total Accepted:       ${color(String(guard.admission.totals.accepted), ANSI.green)}`.padEnd(87) + color('║', ANSI.cyan));
    console.log(color('║', ANSI.cyan) + `   Total Rejected:       ${color(String(guard.admission.totals.rejected), ANSI.red)}`.padEnd(87) + color('║', ANSI.cyan));
    console.log(color('║', ANSI.cyan) + `   Slot Timeouts:        ${color(String(guard.slots.events.timeouts), ANSI.yellow)}`.padEnd(87) + color('║', ANSI.cyan));
    console.log(color('║', ANSI.cyan) + `   DLQ Total Added:      ${color(String(guard.dlq.totalAdded), ANSI.yellow)}`.padEnd(87) + color('║', ANSI.cyan));
    console.log(color('║', ANSI.cyan) + `   DLQ Total Retried:    ${color(String(guard.dlq.totalRetries), ANSI.cyan)}`.padEnd(87) + color('║', ANSI.cyan));

    console.log(color('╠══════════════════════════════════════════════════════════════════════════════╣', ANSI.cyan));

    // Retries
    const executor = finalStats.components.executor;
    console.log(color('║', ANSI.cyan) + color(' 🔄 RETRIES', ANSI.yellow, ANSI.bold).padEnd(86) + color('║', ANSI.cyan));
    console.log(color('║', ANSI.cyan) + `   Retry Attempts:       ${color(String(executor.retries.attempted), ANSI.yellow)}`.padEnd(87) + color('║', ANSI.cyan));
    console.log(color('║', ANSI.cyan) + `   Retry Succeeded:      ${color(String(executor.retries.succeeded), ANSI.green)}`.padEnd(87) + color('║', ANSI.cyan));
    console.log(color('║', ANSI.cyan) + `   Retry Exhausted:      ${color(String(executor.retries.exhausted), ANSI.red)}`.padEnd(87) + color('║', ANSI.cyan));

    console.log(color('╠══════════════════════════════════════════════════════════════════════════════╣', ANSI.cyan));

    // WAL Statistics
    const eventLog = finalStats.components.eventLog;
    console.log(color('║', ANSI.cyan) + color(' 📝 WAL (Event Log)', ANSI.yellow, ANSI.bold).padEnd(86) + color('║', ANSI.cyan));
    console.log(color('║', ANSI.cyan) + `   Current Sequence:     ${color(String(eventLog.sequence.current), ANSI.cyan)}`.padEnd(87) + color('║', ANSI.cyan));
    console.log(color('║', ANSI.cyan) + `   Total Writes:         ${color(String(eventLog.volume.entriesWritten), ANSI.green)}`.padEnd(87) + color('║', ANSI.cyan));
    console.log(color('║', ANSI.cyan) + `   Rotations:            ${color(String(eventLog.rotation.count), ANSI.yellow)}`.padEnd(87) + color('║', ANSI.cyan));

    console.log(color('╠══════════════════════════════════════════════════════════════════════════════╣', ANSI.cyan));

    // Flush Statistics
    const flush = finalStats.components.flush;
    const walWrites = finalStats.components.eventLog.volume.entriesWritten;
    console.log(color('║', ANSI.cyan) + color(' 💾 FLUSH (Persistence)', ANSI.yellow, ANSI.bold).padEnd(86) + color('║', ANSI.cyan));
    if (flush.worker) {
      const flushPct = walWrites > 0 ? ((flush.worker.totalEntriesFlushed / walWrites) * 100).toFixed(1) : '0';
      const avgFlushThroughput = metrics.flushThroughputHistory.length > 0
        ? (metrics.flushThroughputHistory.reduce((a, b) => a + b, 0) / metrics.flushThroughputHistory.length).toFixed(0)
        : '0';
      const peakFlushThroughput = metrics.flushThroughputHistory.length > 0
        ? Math.max(...metrics.flushThroughputHistory)
        : 0;

      console.log(color('║', ANSI.cyan) + `   Total Flushes:        ${color(String(flush.worker.flushCount), ANSI.cyan)}`.padEnd(87) + color('║', ANSI.cyan));
      console.log(color('║', ANSI.cyan) + `   Entries Flushed:      ${color(String(flush.worker.totalEntriesFlushed), ANSI.green)} / ${color(String(walWrites), ANSI.white)} (${flushPct}%)`.padEnd(87) + color('║', ANSI.cyan));
      console.log(color('║', ANSI.cyan) + `   Avg Throughput:       ${color(avgFlushThroughput + ' entries/s', ANSI.cyan)}`.padEnd(87) + color('║', ANSI.cyan));
      console.log(color('║', ANSI.cyan) + `   Peak Throughput:      ${color(peakFlushThroughput + ' entries/s', ANSI.cyan, ANSI.bold)}`.padEnd(87) + color('║', ANSI.cyan));
      console.log(color('║', ANSI.cyan) + `   Flush Errors:         ${color(String(flush.worker.errorCount), flush.worker.errorCount > 0 ? ANSI.red : ANSI.green)}`.padEnd(87) + color('║', ANSI.cyan));

      // Graceful shutdown flush timing
      if (metrics.flushStartedAt && metrics.flushCompletedAt) {
        const shutdownFlushDuration = metrics.flushCompletedAt - metrics.flushStartedAt;
        console.log(color('║', ANSI.cyan) + `   Shutdown Drain Time:  ${color(formatDuration(shutdownFlushDuration), ANSI.yellow)}`.padEnd(87) + color('║', ANSI.cyan));
      }

      if (flush.worker.lastError) {
        console.log(color('║', ANSI.cyan) + `   Last Error:           ${color(flush.worker.lastError.substring(0, 50), ANSI.red)}`.padEnd(87) + color('║', ANSI.cyan));
      }
    }

    console.log(color('╠══════════════════════════════════════════════════════════════════════════════╣', ANSI.cyan));

    // User Distribution Summary
    console.log(color('║', ANSI.cyan) + color(' 👥 USER DISTRIBUTION', ANSI.yellow, ANSI.bold).padEnd(86) + color('║', ANSI.cyan));
    const userStats = Array.from(metrics.userTaskCounts.values());
    const totalUserSubmitted = userStats.reduce((a, b) => a + b.submitted, 0);
    const totalUserCompleted = userStats.reduce((a, b) => a + b.completed, 0);
    const totalUserFailed = userStats.reduce((a, b) => a + b.failed, 0);
    const avgPerUser = totalUserSubmitted / metrics.totalUsers;
    console.log(color('║', ANSI.cyan) + `   Active Users:         ${color(String(metrics.totalUsers), ANSI.cyan)}`.padEnd(87) + color('║', ANSI.cyan));
    console.log(color('║', ANSI.cyan) + `   Avg Tasks/User:       ${color(avgPerUser.toFixed(1), ANSI.white)}`.padEnd(87) + color('║', ANSI.cyan));
    console.log(color('║', ANSI.cyan) + `   Total User Completed: ${color(String(totalUserCompleted), ANSI.green)}`.padEnd(87) + color('║', ANSI.cyan));
    console.log(color('║', ANSI.cyan) + `   Total User Failed:    ${color(String(totalUserFailed), ANSI.red)}`.padEnd(87) + color('║', ANSI.cyan));

    console.log(color('╚══════════════════════════════════════════════════════════════════════════════╝', ANSI.cyan, ANSI.bold));
    console.log('');

    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Wait for all submissions to complete
  await Promise.all(userPromises);

  // Wait for all tasks to complete
  console.log(color('\n  All tasks submitted. Waiting for completion...', ANSI.dim));

  // Poll until all tasks complete or timeout
  const completionTimeout = 120_000; // 2 minutes max wait
  const startWait = Date.now();

  while (running && Date.now() - startWait < completionTimeout) {
    const stats = taskSystem.getStats();
    if (stats.tasks.inFlight === 0) {
      break;
    }
    await sleep(500);
  }

  // Trigger shutdown
  await shutdown();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Run the demo
main().catch(err => {
  console.log(ANSI.showCursor);
  console.error('Demo error:', err);
  process.exit(1);
});
