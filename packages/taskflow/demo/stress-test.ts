/**
 * TaskFlow Stress Test
 *
 * Pushes TaskFlow to its limits with fire-and-forget submission:
 *   - 100% CAPACITY: System saturated, queue full
 *   - 150% CAPACITY: Overloaded, rejections start
 *   - 200% CAPACITY: Heavy overload, massive rejections
 *   - 300% CAPACITY: Extreme overload, system under siege
 *
 * Usage:
 *   npx tsx demo/stress-test.ts
 *
 * Environment:
 *   STRESS_CONCURRENCY=50    Max concurrent tasks
 *   STRESS_QUEUE=100         Max queue size
 */

import {
  TaskSystem,
  userId,
  idempotencyKey,
} from '../src/index.js';
import * as fs from 'node:fs';

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  concurrency: parseInt(process.env.STRESS_CONCURRENCY ?? '50', 10),
  queueSize: parseInt(process.env.STRESS_QUEUE ?? '100', 10),
  taskDurationMs: { min: 500, max: 1500 }, // Tasks take 500-1500ms (avg 1000ms)
};

// Calculate throughput based on average task duration
const AVG_TASK_DURATION = (CONFIG.taskDurationMs.min + CONFIG.taskDurationMs.max) / 2;
const MAX_THROUGHPUT = Math.floor((CONFIG.concurrency / AVG_TASK_DURATION) * 1000);

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

function log(message: string) {
  const time = new Date().toISOString().substring(11, 23);
  console.log(`${COLORS.dim}[${time}]${COLORS.reset} ${message}`);
}

function header(title: string) {
  console.log(`\n${COLORS.bold}${COLORS.cyan}=== ${title} ===${COLORS.reset}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// Stress Test
// ============================================================================

interface PhaseResult {
  name: string;
  targetRate: number;
  actualRate: number;
  submitted: number;
  accepted: number;
  completed: number;
  failed: number;
  rejected: number;
  peakQueue: number;
  peakExecuting: number;
  duration: number;
}

async function main() {
  console.log(`\n${COLORS.bold}${COLORS.blue}╔════════════════════════════════════════════════════════════╗${COLORS.reset}`);
  console.log(`${COLORS.bold}${COLORS.blue}║             TASKFLOW STRESS TEST                           ║${COLORS.reset}`);
  console.log(`${COLORS.bold}${COLORS.blue}║             (Fire-and-Forget Mode)                         ║${COLORS.reset}`);
  console.log(`${COLORS.bold}${COLORS.blue}╚════════════════════════════════════════════════════════════╝${COLORS.reset}\n`);

  log(`Concurrency: ${CONFIG.concurrency} slots`);
  log(`Queue size: ${CONFIG.queueSize}`);
  log(`Task duration: ${CONFIG.taskDurationMs.min}-${CONFIG.taskDurationMs.max}ms (avg ${AVG_TASK_DURATION}ms)`);
  log(`Max throughput: ~${MAX_THROUGHPUT} tasks/sec`);
  log(`Mode: ${COLORS.red}FIRE-AND-FORGET${COLORS.reset} (true stress testing)`);

  const demoDir = './.taskflow-stress-test';
  fs.rmSync(demoDir, { recursive: true, force: true });
  fs.mkdirSync(demoDir, { recursive: true });

  const taskSystem = new TaskSystem({
    repository: { type: 'sqlite', database: `${demoDir}/stress.db` },
    eventLog: { eventLogPath: `${demoDir}/event.log` },
    guard: {
      backpressure: {
        maxQueuedSize: CONFIG.queueSize,
        queueWaitTimeoutMs: 0, // Immediate rejection when queue full
        windowSizeMs: 60_000,
        maxTasksPerWindow: 100000,
        maxTasksPerUserWindow: 50000,
      },
      slots: {
        maxExecutionGlobal: CONFIG.concurrency,
        maxExecutionPerUser: 20,
      },
    },
    executor: {
      retry: {
        maxAttempts: 3,
        initialDelayMs: 20,
        maxDelayMs: 200,
        backoffMultiplier: 2,
      },
    },
    flush: { flushIntervalMs: 50 },
  });

  let failureRate = 0;
  let taskId = 0;

  const stressTask = taskSystem.registerTask({
    name: 'stress-task',
    description: 'Variable-duration task for stress testing',
    type: 'user',
    handler: async function* () {
      if (Math.random() < failureRate) {
        throw new Error('Simulated failure');
      }
      // Random duration between min and max
      const duration = CONFIG.taskDurationMs.min +
        Math.random() * (CONFIG.taskDurationMs.max - CONFIG.taskDurationMs.min);
      await sleep(duration);
      yield { type: 'progress', payload: { done: true } };
      return { ok: true };
    },
  });

  await taskSystem.initialize();
  log('TaskFlow initialized\n');

  const results: PhaseResult[] = [];

  /**
   * Run a phase with FIRE-AND-FORGET submission
   * Tasks are submitted without awaiting - this truly stresses the system
   */
  async function runPhase(
    name: string,
    targetRate: number,
    durationSec: number,
    options: { failRate?: number } = {}
  ): Promise<PhaseResult> {
    header(name);

    failureRate = options.failRate ?? 0;

    const capacityPct = Math.round((targetRate / MAX_THROUGHPUT) * 100);
    log(`Target: ${targetRate} tasks/sec (${capacityPct}% of max throughput)`);
    if (options.failRate) {
      log(`Failure rate: ${Math.round(options.failRate * 100)}%`);
    }

    const startStats = taskSystem.getStats();
    const startCompleted = startStats.tasks.totalCompleted;
    const startFailed = startStats.tasks.totalFailed;

    let submitted = 0;
    let accepted = 0;
    let rejected = 0;
    let peakQueue = 0;
    let peakExecuting = 0;

    const startTime = Date.now();
    const endTime = startTime + (durationSec * 1000);

    // Interval between submissions to achieve target rate
    const intervalMs = 1000 / targetRate;

    // Real-time display
    const displayInterval = setInterval(() => {
      const stats = taskSystem.getStats();
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const completed = stats.tasks.totalCompleted - startCompleted;
      const failed = stats.tasks.totalFailed - startFailed;
      const actualRate = submitted > 0 ? Math.round(submitted / parseFloat(elapsed)) : 0;
      const acceptRate = submitted > 0 ? Math.round((accepted / submitted) * 100) : 100;

      // Track peaks
      if (stats.tasks.queued > peakQueue) peakQueue = stats.tasks.queued;
      if (stats.tasks.executing > peakExecuting) peakExecuting = stats.tasks.executing;

      process.stdout.write('\r' +
        `  ${COLORS.dim}${elapsed.padStart(5)}s${COLORS.reset} │ ` +
        `Q: ${COLORS.yellow}${stats.tasks.queued.toString().padStart(3)}${COLORS.reset}/${CONFIG.queueSize} │ ` +
        `Ex: ${COLORS.green}${stats.tasks.executing.toString().padStart(2)}${COLORS.reset}/${CONFIG.concurrency} │ ` +
        `Rate: ${COLORS.cyan}${actualRate.toString().padStart(4)}${COLORS.reset}/s │ ` +
        `Acc: ${acceptRate >= 90 ? COLORS.green : acceptRate >= 50 ? COLORS.yellow : COLORS.red}${acceptRate.toString().padStart(3)}%${COLORS.reset} │ ` +
        `Rej: ${COLORS.red}${rejected.toString().padStart(5)}${COLORS.reset} │ ` +
        `Done: ${COLORS.green}${completed.toString().padStart(5)}${COLORS.reset}` +
        (failed > 0 ? ` │ Fail: ${COLORS.red}${failed}${COLORS.reset}` : '') +
        '    '
      );
    }, 100);

    // FIRE-AND-FORGET: Submit tasks without waiting for acceptance
    // Use a tight loop with minimal delay to achieve target rate
    const submissionLoop = async () => {
      while (Date.now() < endTime) {
        const id = taskId++;
        submitted++;

        // Fire without awaiting - track via callbacks
        stressTask.run({
          input: {},
          userId: userId(`user-${id % 50}`),
          idempotencyKey: idempotencyKey(`stress-${id}`),
        }).then(() => {
          accepted++;
        }).catch(() => {
          rejected++;
        });

        // Tiny delay to spread submissions (not waiting for task acceptance)
        await sleep(intervalMs);
      }
    };

    await submissionLoop();

    // Wait for in-flight tasks to complete
    process.stdout.write('\n');
    log('Draining in-flight tasks...');

    const drainStart = Date.now();
    const drainTimeout = 30000; // 30 second drain timeout

    while (Date.now() - drainStart < drainTimeout) {
      const stats = taskSystem.getStats();
      if (stats.tasks.inFlight === 0) break;

      // Update peaks during drain
      if (stats.tasks.queued > peakQueue) peakQueue = stats.tasks.queued;
      if (stats.tasks.executing > peakExecuting) peakExecuting = stats.tasks.executing;

      process.stdout.write(`\r  Draining: ${stats.tasks.inFlight} in-flight (Q:${stats.tasks.queued} Ex:${stats.tasks.executing})    `);
      await sleep(100);
    }

    clearInterval(displayInterval);
    process.stdout.write('\r' + ' '.repeat(100) + '\r');

    const endStats = taskSystem.getStats();
    const duration = (Date.now() - startTime) / 1000;
    const actualRate = Math.round(submitted / durationSec);

    const result: PhaseResult = {
      name,
      targetRate,
      actualRate,
      submitted,
      accepted,
      completed: endStats.tasks.totalCompleted - startCompleted,
      failed: endStats.tasks.totalFailed - startFailed,
      rejected,
      peakQueue,
      peakExecuting,
      duration,
    };

    // Summary
    const acceptPct = submitted > 0 ? Math.round((accepted / submitted) * 100) : 0;
    const rejectPct = submitted > 0 ? Math.round((rejected / submitted) * 100) : 0;

    log(`Submitted: ${COLORS.cyan}${submitted}${COLORS.reset} at ${actualRate}/s (target: ${targetRate}/s)`);
    log(`Accepted: ${COLORS.green}${accepted}${COLORS.reset} (${acceptPct}%) │ Rejected: ${COLORS.red}${rejected}${COLORS.reset} (${rejectPct}%)`);
    log(`Peak: Queue ${COLORS.yellow}${peakQueue}/${CONFIG.queueSize}${COLORS.reset}, Exec ${COLORS.green}${peakExecuting}/${CONFIG.concurrency}${COLORS.reset}`);

    if (result.failed > 0) {
      log(`Task failures: ${COLORS.red}${result.failed}${COLORS.reset} (retried and exhausted)`);
    }

    return result;
  }

  // ========== PHASE 1: WARMUP (50% capacity) ==========
  const warmup = await runPhase('WARMUP - 50% Capacity', Math.floor(MAX_THROUGHPUT * 0.5), 10);
  results.push(warmup);
  log(`${COLORS.green}✓ System warmed up${COLORS.reset}`);

  // ========== PHASE 2: 100% CAPACITY ==========
  const full = await runPhase('SATURATE - 100% Capacity', MAX_THROUGHPUT, 15);
  results.push(full);

  if (full.peakQueue >= CONFIG.queueSize * 0.8) {
    log(`${COLORS.green}✓ Queue saturated (${full.peakQueue}/${CONFIG.queueSize})${COLORS.reset}`);
  } else {
    log(`${COLORS.yellow}⚠ Queue not fully saturated (${full.peakQueue}/${CONFIG.queueSize})${COLORS.reset}`);
  }

  // ========== PHASE 3: 150% CAPACITY ==========
  const overload = await runPhase('OVERLOAD - 150% Capacity', Math.floor(MAX_THROUGHPUT * 1.5), 15);
  results.push(overload);

  if (overload.rejected > overload.submitted * 0.2) {
    log(`${COLORS.green}✓ Backpressure active - ${Math.round(overload.rejected / overload.submitted * 100)}% rejected${COLORS.reset}`);
  } else {
    log(`${COLORS.yellow}⚠ Expected more rejections at 150% capacity${COLORS.reset}`);
  }

  // ========== PHASE 4: 200% CAPACITY ==========
  const heavy = await runPhase('HEAVY - 200% Capacity', Math.floor(MAX_THROUGHPUT * 2), 15);
  results.push(heavy);

  if (heavy.rejected > heavy.submitted * 0.4) {
    log(`${COLORS.green}✓ Heavy backpressure - ${Math.round(heavy.rejected / heavy.submitted * 100)}% rejected${COLORS.reset}`);
  }

  // ========== PHASE 5: 300% CAPACITY (EXTREME) ==========
  const extreme = await runPhase('EXTREME - 300% Capacity', Math.floor(MAX_THROUGHPUT * 3), 15);
  results.push(extreme);

  if (extreme.rejected > extreme.submitted * 0.5) {
    log(`${COLORS.green}✓ System survived extreme load - ${Math.round(extreme.rejected / extreme.submitted * 100)}% rejected${COLORS.reset}`);
  }

  // ========== PHASE 6: FAILURES UNDER LOAD ==========
  const failures = await runPhase('CHAOS - 150% + 30% Failures', Math.floor(MAX_THROUGHPUT * 1.5), 15, { failRate: 0.3 });
  results.push(failures);

  const executor = taskSystem.getStats().components.executor;
  if (executor.retries.succeeded > 0) {
    log(`${COLORS.green}✓ Retries recovered ${executor.retries.succeeded} tasks${COLORS.reset}`);
  }

  // ========== FINAL RESULTS ==========
  header('FINAL RESULTS');

  const totalSubmitted = results.reduce((s, r) => s + r.submitted, 0);
  const totalAccepted = results.reduce((s, r) => s + r.accepted, 0);
  const totalRejected = results.reduce((s, r) => s + r.rejected, 0);
  const totalDuration = results.reduce((s, r) => s + r.duration, 0);

  const finalStats = taskSystem.getStats();
  const successRate = finalStats.tasks.totalCompleted + finalStats.tasks.totalFailed > 0
    ? (finalStats.tasks.totalCompleted / (finalStats.tasks.totalCompleted + finalStats.tasks.totalFailed) * 100)
    : 0;

  console.log(`  ${COLORS.bold}Duration:${COLORS.reset}      ${totalDuration.toFixed(1)}s`);
  console.log(`  ${COLORS.bold}Submitted:${COLORS.reset}     ${totalSubmitted}`);
  console.log(`  ${COLORS.bold}Accepted:${COLORS.reset}      ${COLORS.green}${totalAccepted}${COLORS.reset} (${Math.round(totalAccepted / totalSubmitted * 100)}%)`);
  console.log(`  ${COLORS.bold}Rejected:${COLORS.reset}      ${COLORS.red}${totalRejected}${COLORS.reset} (${Math.round(totalRejected / totalSubmitted * 100)}%)`);
  console.log(`  ${COLORS.bold}Completed:${COLORS.reset}     ${COLORS.green}${finalStats.tasks.totalCompleted}${COLORS.reset}`);
  console.log(`  ${COLORS.bold}Failed:${COLORS.reset}        ${COLORS.red}${finalStats.tasks.totalFailed}${COLORS.reset}`);
  console.log(`  ${COLORS.bold}Success Rate:${COLORS.reset}  ${successRate.toFixed(1)}%`);
  console.log('');
  console.log(`  ${COLORS.bold}Retries:${COLORS.reset}       ${executor.retries.attempted} attempted → ${executor.retries.succeeded} recovered`);
  console.log(`  ${COLORS.bold}Peak Queue:${COLORS.reset}    ${Math.max(...results.map(r => r.peakQueue))}/${CONFIG.queueSize}`);
  console.log(`  ${COLORS.bold}Peak Exec:${COLORS.reset}     ${Math.max(...results.map(r => r.peakExecuting))}/${CONFIG.concurrency}`);

  // Per-phase summary
  header('PHASE BREAKDOWN');

  console.log(`  ${'Phase'.padEnd(28)} ${'Target'.padStart(8)} ${'Actual'.padStart(8)} ${'Accept'.padStart(8)} ${'Reject'.padStart(8)} ${'Rej%'.padStart(6)}`);
  console.log(`  ${'-'.repeat(75)}`);

  for (const r of results) {
    const rejPct = r.submitted > 0 ? Math.round(r.rejected / r.submitted * 100) : 0;
    const rejColor = rejPct > 50 ? COLORS.red : rejPct > 20 ? COLORS.yellow : COLORS.green;
    console.log(
      `  ${r.name.padEnd(28)} ` +
      `${(r.targetRate + '/s').padStart(8)} ` +
      `${(r.actualRate + '/s').padStart(8)} ` +
      `${r.accepted.toString().padStart(8)} ` +
      `${r.rejected.toString().padStart(8)} ` +
      `${rejColor}${(rejPct + '%').padStart(6)}${COLORS.reset}`
    );
  }

  // Status
  header('TEST STATUS');

  const peakQueue = Math.max(...results.map(r => r.peakQueue));
  const checks = [
    {
      name: 'Queue Saturation',
      pass: peakQueue >= CONFIG.queueSize * 0.95,
      detail: `Peak ${peakQueue}/${CONFIG.queueSize} (${Math.round(peakQueue / CONFIG.queueSize * 100)}%)`
    },
    {
      name: 'Backpressure',
      pass: totalRejected > totalSubmitted * 0.15,
      detail: `${totalRejected} rejected (${Math.round(totalRejected / totalSubmitted * 100)}%)`
    },
    {
      name: 'Stability',
      pass: finalStats.tasks.inFlight === 0,
      detail: finalStats.tasks.inFlight === 0 ? 'All tasks drained' : `${finalStats.tasks.inFlight} still in-flight`
    },
    {
      name: 'Retries',
      pass: executor.retries.succeeded > 0,
      detail: `${executor.retries.succeeded}/${executor.retries.attempted} recovered`
    },
    {
      name: 'Extreme Survival',
      pass: extreme.accepted > 0 && extreme.peakExecuting >= CONFIG.concurrency * 0.9,
      detail: `Handled ${extreme.accepted} at 300% load`
    },
  ];

  let allPassed = true;
  for (const check of checks) {
    const icon = check.pass ? `${COLORS.green}✓${COLORS.reset}` : `${COLORS.red}✗${COLORS.reset}`;
    console.log(`  ${icon} ${check.name}: ${check.detail}`);
    if (!check.pass) allPassed = false;
  }

  console.log('');
  if (allPassed) {
    console.log(`  ${COLORS.green}${COLORS.bold}STRESS TEST PASSED${COLORS.reset}\n`);
  } else {
    console.log(`  ${COLORS.yellow}${COLORS.bold}STRESS TEST COMPLETED WITH WARNINGS${COLORS.reset}\n`);
  }

  await taskSystem.shutdown({ deleteFiles: true });
  fs.rmSync(demoDir, { recursive: true, force: true });
}

main().catch(err => {
  console.error('Stress test error:', err);
  process.exit(1);
});
