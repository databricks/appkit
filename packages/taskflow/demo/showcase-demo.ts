/**
 * TaskFlow Showcase Demo
 *
 * Demonstrates the real value propositions of TaskFlow:
 *
 * 1. CRASH RECOVERY - Kill the process mid-run, restart, tasks resume from checkpoint
 * 2. BACKPRESSURE - System rejects work when overloaded instead of crashing
 * 3. FAIR SCHEDULING - Multiple tenants share resources fairly
 * 4. IDEMPOTENCY - Same task submitted twice only executes once
 * 5. REAL-TIME STREAMING - Progress events streamed per-task
 *
 * Usage:
 *   npx tsx demo/showcase-demo.ts [scenario]
 *
 * Scenarios:
 *   recovery     - Demonstrates crash recovery (run twice, kill first run with Ctrl+C)
 *   backpressure - Shows rejection under overload
 *   fairness     - Shows fair scheduling across tenants
 *   idempotency  - Shows duplicate task prevention
 *   streaming    - Shows real-time event streaming per task
 *   all          - Runs all scenarios sequentially (default)
 */

import {
  TaskSystem,
  userId,
  idempotencyKey,
  type TaskHandlerContext,
} from '../src/index.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

// ============================================================================
// CONFIGURATION
// ============================================================================

const DB_PATH = '.taskflow-showcase';
const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgBlue: '\x1b[44m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgRed: '\x1b[41m',
};

function log(color: string, prefix: string, message: string) {
  const timestamp = new Date().toISOString().substring(11, 23);
  console.log(`${COLORS.dim}[${timestamp}]${COLORS.reset} ${color}${prefix}${COLORS.reset} ${message}`);
}

function header(title: string) {
  console.log('\n' + '='.repeat(70));
  console.log(`${COLORS.bright}${COLORS.cyan}  ${title}${COLORS.reset}`);
  console.log('='.repeat(70) + '\n');
}

function subheader(title: string) {
  console.log(`\n${COLORS.yellow}> ${title}${COLORS.reset}\n`);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForKeypress(message: string): Promise<void> {
  console.log(`\n${COLORS.bgBlue}${COLORS.white} ${message} ${COLORS.reset}\n`);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    process.stdin.setRawMode?.(true);
    process.stdin.once('data', () => {
      process.stdin.setRawMode?.(false);
      rl.close();
      resolve();
    });
  });
}

// ============================================================================
// SCENARIO 1: CRASH RECOVERY
// ============================================================================

const TASK_STEPS = [
  'Received request',
  'Planning approach',
  'Analyzing context',
  'Searching documents',
  'Reading results',
  'Querying database',
  'Processing data',
  'Generating insights',
  'Formatting response',
  'Done',
];

async function scenarioRecovery(): Promise<void> {
  header('SCENARIO 1: CRASH RECOVERY');

  console.log(`${COLORS.dim}TaskFlow has two types of task recovery:${COLORS.reset}\n`);
  console.log(`  ${COLORS.cyan}Background tasks${COLORS.reset} - Auto-recover when server restarts`);
  console.log(`  ${COLORS.yellow}User tasks${COLORS.reset}       - Recover when user reconnects\n`);

  const demoDir = path.join(DB_PATH, 'recovery');
  const isResume = fs.existsSync(path.join(demoDir, 'demo.db'));

  if (!isResume) {
    fs.mkdirSync(demoDir, { recursive: true });
  }

  const taskSystem = new TaskSystem({
    repository: { type: 'sqlite', database: `${demoDir}/demo.db` },
    eventLog: { eventLogPath: `${demoDir}/event.log` },
    guard: { slots: { maxExecutionGlobal: 2 } },
    flush: { flushIntervalMs: 200 },
    recovery: {
      enabled: true,
      backgroundPollIntervalMs: 1000,
      staleThresholdMs: 3000,
    },
  });

  // BACKGROUND TASK - auto-recovers on server restart
  const backgroundTask = taskSystem.registerTask({
    name: 'background-report',
    description: 'Background task that auto-recovers',
    type: 'background',

    handler: async function* (_input: { name: string }, _context: TaskHandlerContext) {
      const state: string[] = [];
      for (let i = 0; i < TASK_STEPS.length; i++) {
        state.push(TASK_STEPS[i]);
        yield { type: 'progress', payload: { stepIndex: i, state: [...state] } };
        console.log(`  ${COLORS.cyan}[Background]${COLORS.reset} Step ${i + 1}/${TASK_STEPS.length}: ${TASK_STEPS[i]}`);
        await sleep(500);
      }
      return { state, completed: true };
    },

    recover: async function* (_input: { name: string }, context: any) {
      const prevEvents = context.previousEvents || [];
      const progressEvents = prevEvents.filter((e: any) => e.type === 'progress');

      let state: string[] = [];
      let lastStepIndex = -1;
      if (progressEvents.length > 0) {
        const last = progressEvents[progressEvents.length - 1];
        state = last.payload?.state || [];
        lastStepIndex = last.payload?.stepIndex ?? -1;
      }

      const skipped = lastStepIndex + 1;
      const remaining = TASK_STEPS.length - skipped;

      console.log(`\n  ${COLORS.green}[Background] RECOVERED${COLORS.reset}`);
      console.log(`  ${COLORS.dim}├─ Restored ${skipped} steps from checkpoint (NOT re-executed!)${COLORS.reset}`);
      console.log(`  ${COLORS.dim}├─ Last checkpoint: "${TASK_STEPS[lastStepIndex]}"${COLORS.reset}`);
      console.log(`  ${COLORS.dim}└─ Continuing with ${remaining} remaining steps...${COLORS.reset}\n`);

      for (let i = lastStepIndex + 1; i < TASK_STEPS.length; i++) {
        await sleep(300);
        state.push(TASK_STEPS[i]);
        yield { type: 'progress', payload: { stepIndex: i, state: [...state], recovered: true } };
        console.log(`  ${COLORS.green}[Background]${COLORS.reset} Step ${i + 1}/${TASK_STEPS.length}: ${TASK_STEPS[i]}`);
      }
      return { state, completed: true };
    },
  });

  // USER TASK - recovers when user reconnects with same idempotency key
  const userTask = taskSystem.registerTask({
    name: 'user-chat',
    description: 'User task that recovers on reconnect',
    type: 'user',

    handler: async function* (_input: { name: string }, _context: TaskHandlerContext) {
      const state: string[] = [];
      for (let i = 0; i < TASK_STEPS.length; i++) {
        state.push(TASK_STEPS[i]);
        yield { type: 'progress', payload: { stepIndex: i, state: [...state] } };
        console.log(`  ${COLORS.yellow}[User Chat]${COLORS.reset}  Step ${i + 1}/${TASK_STEPS.length}: ${TASK_STEPS[i]}`);
        await sleep(500);
      }
      return { state, completed: true };
    },

    recover: async function* (_input: { name: string }, context: any) {
      const prevEvents = context.previousEvents || [];
      const progressEvents = prevEvents.filter((e: any) => e.type === 'progress');

      let state: string[] = [];
      let lastStepIndex = -1;
      if (progressEvents.length > 0) {
        const last = progressEvents[progressEvents.length - 1];
        state = last.payload?.state || [];
        lastStepIndex = last.payload?.stepIndex ?? -1;
      }

      const skipped = lastStepIndex + 1;
      const remaining = TASK_STEPS.length - skipped;

      console.log(`\n  ${COLORS.green}[User Chat] RECOVERED${COLORS.reset}`);
      console.log(`  ${COLORS.dim}├─ Restored ${skipped} steps from checkpoint (NOT re-executed!)${COLORS.reset}`);
      console.log(`  ${COLORS.dim}├─ Last checkpoint: "${TASK_STEPS[lastStepIndex]}"${COLORS.reset}`);
      console.log(`  ${COLORS.dim}└─ Continuing with ${remaining} remaining steps...${COLORS.reset}\n`);

      for (let i = lastStepIndex + 1; i < TASK_STEPS.length; i++) {
        await sleep(300);
        state.push(TASK_STEPS[i]);
        yield { type: 'progress', payload: { stepIndex: i, state: [...state], recovered: true } };
        console.log(`  ${COLORS.green}[User Chat]${COLORS.reset}  Step ${i + 1}/${TASK_STEPS.length}: ${TASK_STEPS[i]}`);
      }
      return { state, completed: true };
    },
  });

  await taskSystem.initialize();

  if (!isResume) {
    // === FIRST RUN ===
    console.log(`${COLORS.bgYellow}${COLORS.bright} Press Ctrl+C to simulate a crash! ${COLORS.reset}\n`);

    // Start both tasks
    await backgroundTask.run({
      input: { name: 'Q3 Report' },
      userId: userId('system'),
      idempotencyKey: idempotencyKey('bg-report'),
    });

    await userTask.run({
      input: { name: 'User Analysis' },
      userId: userId('user-123'),
      idempotencyKey: idempotencyKey('user-chat-123'),
    });

    // Wait for completion
    while (true) {
      const stats = taskSystem.getStats();
      if (stats.tasks.inFlight === 0) break;
      await sleep(300);
    }

    console.log(`\n${COLORS.green}Both tasks completed successfully.${COLORS.reset}`);
    console.log(`${COLORS.dim}Run again - nothing to recover.${COLORS.reset}\n`);

  } else {
    // === SECOND RUN (RECOVERY) ===
    console.log(`${COLORS.bgGreen}${COLORS.white}${COLORS.bright} RECOVERY MODE ${COLORS.reset}\n`);

    console.log(`${COLORS.cyan}1. Background task:${COLORS.reset} Auto-recovering on startup...\n`);

    // Wait for background task recovery
    const startWait = Date.now();
    while (Date.now() - startWait < 15000) {
      const stats = taskSystem.getStats();
      if (stats.components.recovery.outcomes.background > 0 && stats.tasks.inFlight === 0) {
        break;
      }
      await sleep(300);
    }

    console.log(`\n${COLORS.green}Background task recovered automatically!${COLORS.reset}\n`);

    // Wait for user to press Enter
    await waitForKeypress('Press Enter to simulate user reconnection...');

    console.log(`${COLORS.yellow}2. User task:${COLORS.reset} Recovering on reconnection...\n`);

    await userTask.run({
      input: { name: 'User Analysis' },
      userId: userId('user-123'),
      idempotencyKey: idempotencyKey('user-chat-123'),
    });

    // Wait for user task to complete
    while (true) {
      const stats = taskSystem.getStats();
      if (stats.tasks.inFlight === 0) break;
      await sleep(300);
    }

    console.log(`\n${COLORS.green}${COLORS.bright}All tasks recovered!${COLORS.reset}`);
    console.log(`${COLORS.dim}Key point: Steps before crash were NOT re-executed.${COLORS.reset}\n`);
  }

  await taskSystem.shutdown();

  if (isResume) {
    fs.rmSync(demoDir, { recursive: true, force: true });
  }
}

// ============================================================================
// SCENARIO 2: BACKPRESSURE
// ============================================================================

async function scenarioBackpressure(): Promise<void> {
  header('SCENARIO 2: BACKPRESSURE');

  console.log(`${COLORS.dim}TaskFlow protects your system from overload with two modes:${COLORS.reset}\n`);

  const demoDir = path.join(DB_PATH, 'backpressure');
  fs.rmSync(demoDir, { recursive: true, force: true });
  fs.mkdirSync(demoDir, { recursive: true });

  // === PART 1: With Timeout (Wait Pattern) ===
  subheader('1. Wait for Capacity (with timeout)');

  console.log(`${COLORS.dim}When queue is full, tasks wait until capacity is available.${COLORS.reset}\n`);

  const taskSystem1 = new TaskSystem({
    repository: { type: 'sqlite', database: `${demoDir}/demo1.db` },
    eventLog: { eventLogPath: `${demoDir}/event1.log` },
    guard: {
      slots: { maxExecutionGlobal: 2 },
      backpressure: {
        maxQueuedSize: 3,
        queueWaitTimeoutMs: 30000, // Wait up to 30s for capacity
        windowSizeMs: 60_000,
        maxTasksPerWindow: 10000,
        maxTasksPerUserWindow: 10000,
      },
    },
    flush: { flushIntervalMs: 200 },
  });

  const waitTask = taskSystem1.registerTask({
    name: 'wait-task',
    description: 'Task for wait demo',
    type: 'user',
    handler: async () => {
      await sleep(500);
      return { ok: true };
    },
  });

  await taskSystem1.initialize();

  console.log(`${COLORS.bright}Submitting 8 tasks (queue capacity: 3):${COLORS.reset}\n`);

  const startTime = Date.now();
  for (let i = 1; i <= 8; i++) {
    const taskStart = Date.now();
    await waitTask.run({
      input: {},
      userId: userId('user'),
      idempotencyKey: idempotencyKey(`wait-${i}`),
    });
    const waited = Date.now() - taskStart;
    if (waited > 10) {
      console.log(`  Task ${i}: ${COLORS.yellow}Waited ${waited}ms${COLORS.reset} for capacity`);
    } else {
      console.log(`  Task ${i}: ${COLORS.green}Accepted immediately${COLORS.reset}`);
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${COLORS.cyan}All 8 tasks accepted over ${totalTime}s (system throttled intake).${COLORS.reset}`);

  while (taskSystem1.getStats().tasks.inFlight > 0) await sleep(100);
  await taskSystem1.shutdown();

  // === PART 2: Without Timeout (Rejection Pattern) ===
  subheader('2. Immediate Rejection (no timeout)');

  console.log(`${COLORS.dim}When queue is full, excess tasks are rejected immediately.${COLORS.reset}\n`);

  const taskSystem2 = new TaskSystem({
    repository: { type: 'sqlite', database: `${demoDir}/demo2.db` },
    eventLog: { eventLogPath: `${demoDir}/event2.log` },
    guard: {
      slots: { maxExecutionGlobal: 2 },
      backpressure: {
        maxQueuedSize: 3,
        queueWaitTimeoutMs: 0, // Reject immediately
        windowSizeMs: 60_000,
        maxTasksPerWindow: 10000,
        maxTasksPerUserWindow: 10000,
      },
    },
    flush: { flushIntervalMs: 200 },
  });

  const rejectTask = taskSystem2.registerTask({
    name: 'reject-task',
    description: 'Task for rejection demo',
    type: 'user',
    handler: async () => {
      await sleep(2000);
      return { ok: true };
    },
  });

  await taskSystem2.initialize();

  console.log(`${COLORS.bright}Submitting 8 tasks (queue capacity: 3):${COLORS.reset}\n`);

  let accepted = 0;
  let rejected = 0;

  for (let i = 1; i <= 8; i++) {
    try {
      await rejectTask.run({
        input: {},
        userId: userId('user'),
        idempotencyKey: idempotencyKey(`reject-${i}`),
      });
      accepted++;
      console.log(`  Task ${i}: ${COLORS.green}Accepted${COLORS.reset}`);
    } catch {
      rejected++;
      console.log(`  Task ${i}: ${COLORS.red}Rejected${COLORS.reset} - queue full`);
    }
  }

  console.log(`\n${COLORS.bright}Result:${COLORS.reset} ${COLORS.green}${accepted} accepted${COLORS.reset}, ${COLORS.red}${rejected} rejected${COLORS.reset}`);
  console.log(`\n${COLORS.cyan}System protected itself from overload by rejecting excess tasks.${COLORS.reset}`);

  await taskSystem2.shutdown({ force: true });
  fs.rmSync(demoDir, { recursive: true, force: true });
}

// ============================================================================
// SCENARIO 3: FAIR SCHEDULING
// ============================================================================

async function scenarioFairness(): Promise<void> {
  header('SCENARIO 3: FAIR SCHEDULING');

  console.log(`${COLORS.dim}This demonstrates TaskFlow's tenant fairness.`);
  console.log(`When multiple tenants compete for resources, each gets a fair share`);
  console.log(`- no single tenant can monopolize the system.${COLORS.reset}\n`);

  const demoDir = path.join(DB_PATH, 'fairness');
  fs.rmSync(demoDir, { recursive: true, force: true });
  fs.mkdirSync(demoDir, { recursive: true });

  // Track per-tenant execution
  const tenantExecuting: Record<string, number> = {
    'greedy': 0,
    'tenant-A': 0,
    'tenant-B': 0,
    'tenant-C': 0,
  };
  const tenantCompleted: Record<string, number> = {
    'greedy': 0,
    'tenant-A': 0,
    'tenant-B': 0,
    'tenant-C': 0,
  };

  const taskSystem = new TaskSystem({
    repository: {
      type: 'sqlite',
      database: `${demoDir}/demo.db`,
    },
    eventLog: {
      eventLogPath: `${demoDir}/event.log`,
    },
    guard: {
      slots: {
        maxExecutionGlobal: 10,
        maxExecutionPerUser: 3, // Each tenant limited to 3 concurrent
      },
    },
    flush: {
      flushIntervalMs: 200,
    },
  });

  const tenantTask = taskSystem.registerTask({
    name: 'tenant-task',
    description: 'Task for fairness demo',
    type: 'user',
    handler: async (input: { tenant: string }) => {
      tenantExecuting[input.tenant]++;
      await sleep(500); // 500ms tasks
      tenantExecuting[input.tenant]--;
      tenantCompleted[input.tenant]++;
      return { done: true };
    },
  });

  await taskSystem.initialize();

  subheader('Scenario: Greedy tenant submits 30 tasks, three normal tenants submit 5 each');
  console.log(`${COLORS.dim}Configuration: 10 global slots, max 3 per tenant`);
  console.log(`Watch how slots are distributed fairly across tenants.${COLORS.reset}\n`);

  // Submit all tasks without waiting
  const submissions: Promise<any>[] = [];

  // Greedy tenant tries to hog resources (30 tasks)
  for (let i = 0; i < 30; i++) {
    submissions.push(tenantTask.run({
      input: { tenant: 'greedy' },
      userId: userId('greedy'),
      idempotencyKey: idempotencyKey(`greedy-${i}`),
    }));
  }

  // Normal tenants submit reasonable workloads (5 each)
  for (const tenant of ['tenant-A', 'tenant-B', 'tenant-C']) {
    for (let i = 0; i < 5; i++) {
      submissions.push(tenantTask.run({
        input: { tenant },
        userId: userId(tenant),
        idempotencyKey: idempotencyKey(`${tenant}-${i}`),
      }));
    }
  }

  // Wait for all submissions
  await Promise.all(submissions);
  log(COLORS.blue, '[SUBMITTED]', '45 tasks submitted (30 greedy + 15 normal)');

  console.log(`\n${COLORS.yellow}  Tenant        Executing   Completed${COLORS.reset}`);
  console.log(`  ${'─'.repeat(38)}`);

  // Monitor execution distribution
  const totalTasks = 45;
  let lastLine = '';
  while (true) {
    const stats = taskSystem.getStats();
    const completed = stats.tasks.totalCompleted;

    // Build status line showing per-tenant execution
    const lines = [
      `  ${COLORS.red}greedy${COLORS.reset}         ${tenantExecuting['greedy'].toString().padStart(2)}         ${tenantCompleted['greedy'].toString().padStart(2)}/30`,
      `  ${COLORS.green}tenant-A${COLORS.reset}       ${tenantExecuting['tenant-A'].toString().padStart(2)}          ${tenantCompleted['tenant-A'].toString().padStart(2)}/5`,
      `  ${COLORS.green}tenant-B${COLORS.reset}       ${tenantExecuting['tenant-B'].toString().padStart(2)}          ${tenantCompleted['tenant-B'].toString().padStart(2)}/5`,
      `  ${COLORS.green}tenant-C${COLORS.reset}       ${tenantExecuting['tenant-C'].toString().padStart(2)}          ${tenantCompleted['tenant-C'].toString().padStart(2)}/5`,
    ].join('\n');

    // Only print if changed
    if (lines !== lastLine) {
      // Move cursor up and clear lines
      if (lastLine) {
        process.stdout.write('\x1b[4A\x1b[0J');
      }
      console.log(lines);
      lastLine = lines;
    }

    if (completed >= totalTasks) break;
    await sleep(100);
  }

  console.log(`\n${COLORS.cyan}Key observations:${COLORS.reset}`);
  console.log(`  - Greedy tenant was limited to max 3 concurrent (not all 10 slots)`);
  console.log(`  - Normal tenants got their fair share despite greedy tenant's 30 tasks`);
  console.log(`  - All tenants completed without starvation`);

  await taskSystem.shutdown();
  fs.rmSync(demoDir, { recursive: true, force: true });
}

// ============================================================================
// SCENARIO 4: IDEMPOTENCY
// ============================================================================

async function scenarioIdempotency(): Promise<void> {
  header('SCENARIO 4: IDEMPOTENCY');

  console.log(`${COLORS.dim}This demonstrates TaskFlow's idempotency guarantee.`);
  console.log(`Submitting the same task ID multiple times only executes once.`);
  console.log(`Critical for "at-least-once" delivery systems.${COLORS.reset}\n`);

  const demoDir = path.join(DB_PATH, 'idempotency');
  fs.rmSync(demoDir, { recursive: true, force: true });
  fs.mkdirSync(demoDir, { recursive: true });

  const taskSystem = new TaskSystem({
    repository: {
      type: 'sqlite',
      database: `${demoDir}/demo.db`,
    },
    eventLog: {
      eventLogPath: `${demoDir}/event.log`,
    },
    guard: {
      slots: { maxExecutionGlobal: 10 },
    },
    flush: {
      flushIntervalMs: 200,
    },
  });

  let executionCount = 0;

  const paymentTask = taskSystem.registerTask({
    name: 'payment',
    description: 'Simulated payment processing',
    type: 'user',
    handler: async (input: { amount: number; to: string }) => {
      executionCount++;
      log(COLORS.magenta, '[EXECUTE]', `Processing payment #${executionCount}: $${input.amount} to ${input.to}`);
      await sleep(500);
      return { transactionId: `txn-${Date.now()}`, amount: input.amount };
    },
  });

  await taskSystem.initialize();

  subheader('Simulating network retry scenario...');
  console.log(`${COLORS.dim}Client sends payment request, doesn't get response, retries 5 times.`);
  console.log(`Without idempotency: 5 payments processed!`);
  console.log(`With TaskFlow: Only 1 payment processed.${COLORS.reset}\n`);

  const paymentKey = idempotencyKey('payment-order-12345'); // Same key for all attempts

  // Simulate client retrying same request
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const task = await paymentTask.run({
        input: { amount: 99.99, to: 'merchant-456' },
        userId: userId('user-123'),
        idempotencyKey: paymentKey, // Same key every time!
      });
      log(COLORS.green, `[ATTEMPT ${attempt}]`, `Task accepted: ${task.id.slice(0, 12)}`);
    } catch (error: any) {
      if (error.message.includes('already exists') || error.message.includes('duplicate')) {
        log(COLORS.yellow, `[ATTEMPT ${attempt}]`, 'Duplicate detected - task already submitted');
      } else {
        log(COLORS.red, `[ATTEMPT ${attempt}]`, `Error: ${error.message}`);
      }
    }

    await sleep(200); // Small delay between retries
  }

  // Wait for task to complete
  await sleep(1500);

  subheader('Results');
  console.log(`  Submission attempts: ${COLORS.yellow}5${COLORS.reset}`);
  console.log(`  Actual executions:   ${COLORS.green}${executionCount}${COLORS.reset}`);
  console.log(`\n${COLORS.cyan}Key insight: Despite 5 submission attempts, payment only processed once.`);
  console.log(`The customer won't be charged 5 times!${COLORS.reset}`);

  await taskSystem.shutdown();
  fs.rmSync(demoDir, { recursive: true, force: true });
}

// ============================================================================
// SCENARIO 5: REAL-TIME STREAMING
// ============================================================================

async function scenarioStreaming(): Promise<void> {
  header('SCENARIO 5: PARTIAL PROGRESS (LLM AGENT)');

  console.log(`${COLORS.dim}Most task systems only track: pending → complete (0 or 1).`);
  console.log(`TaskFlow tracks partial progress - each step is persisted.`);
  console.log(`If crashed, the agent can resume with full conversation history.${COLORS.reset}\n`);

  const demoDir = path.join(DB_PATH, 'streaming');
  fs.rmSync(demoDir, { recursive: true, force: true });
  fs.mkdirSync(demoDir, { recursive: true });

  const taskSystem = new TaskSystem({
    repository: { type: 'sqlite', database: `${demoDir}/demo.db` },
    eventLog: { eventLogPath: `${demoDir}/event.log` },
    guard: { slots: { maxExecutionGlobal: 3 } },
    flush: { flushIntervalMs: 200 },
  });

  // Simulated LLM agent that processes a user request in multiple steps
  const agentTask = taskSystem.registerTask({
    name: 'llm-agent',
    description: 'LLM agent that researches and answers questions',
    type: 'user',

    handler: async function* (input: { question: string }, _context: TaskHandlerContext) {
      const conversation: Array<{ role: string; content: string; toolCall?: any }> = [];

      // Step 1: User message
      conversation.push({ role: 'user', content: input.question });
      yield {
        type: 'progress',
        message: 'Received user question',
        payload: { step: 'user_input', conversation: [...conversation] },
      };
      await sleep(300);

      // Step 2: Agent thinks and decides to search
      conversation.push({
        role: 'assistant',
        content: 'I need to search for current information about this.',
        toolCall: { name: 'web_search', args: { query: 'Databricks stock price 2024' } },
      });
      yield {
        type: 'progress',
        message: 'Agent deciding to search...',
        payload: { step: 'tool_call', tool: 'web_search', conversation: [...conversation] },
      };
      await sleep(800);

      // Step 3: Tool result comes back
      conversation.push({
        role: 'tool',
        content: 'Databricks valued at $43B after Series I funding in 2023. Private company.',
      });
      yield {
        type: 'progress',
        message: 'Search results received',
        payload: { step: 'tool_result', conversation: [...conversation] },
      };
      await sleep(500);

      // Step 4: Agent calls another tool
      conversation.push({
        role: 'assistant',
        content: 'Let me get more details about their recent performance.',
        toolCall: { name: 'web_search', args: { query: 'Databricks revenue 2024' } },
      });
      yield {
        type: 'progress',
        message: 'Agent searching for more info...',
        payload: { step: 'tool_call', tool: 'web_search', conversation: [...conversation] },
      };
      await sleep(800);

      // Step 5: Second tool result
      conversation.push({
        role: 'tool',
        content: 'Databricks reported $1.6B ARR in 2023, growing 50% YoY.',
      });
      yield {
        type: 'progress',
        message: 'Additional results received',
        payload: { step: 'tool_result', conversation: [...conversation] },
      };
      await sleep(500);

      // Step 6: Final response
      conversation.push({
        role: 'assistant',
        content: 'Databricks is a private company valued at $43B. They reported $1.6B ARR in 2023 with 50% growth.',
      });
      yield {
        type: 'progress',
        message: 'Agent generating final response',
        payload: { step: 'response', conversation: [...conversation] },
      };

      return { conversation, success: true };
    },
  });

  await taskSystem.initialize();

  subheader('User asks: "What is Databricks stock price?"');
  console.log(`${COLORS.dim}Watch the agent think, call tools, and build up conversation state.${COLORS.reset}`);
  console.log(`${COLORS.dim}Each step is persisted - if crashed, agent resumes with full history.${COLORS.reset}\n`);

  const task = await agentTask.run({
    input: { question: 'What is Databricks stock price?' },
    userId: userId('user-123'),
    idempotencyKey: idempotencyKey('agent-conv-001'),
  }) as any;

  // Show the conversation building up in real-time
  for await (const event of task.stream()) {
    if (event.type === 'progress' && event.payload?.step) {
      const p = event.payload;
      const lastMsg = p.conversation[p.conversation.length - 1];

      switch (p.step) {
        case 'user_input':
          console.log(`  ${COLORS.blue}USER:${COLORS.reset} "${lastMsg.content}"`);
          break;
        case 'tool_call':
          console.log(`  ${COLORS.yellow}AGENT:${COLORS.reset} ${lastMsg.content}`);
          console.log(`         ${COLORS.magenta}→ calling ${lastMsg.toolCall.name}(${JSON.stringify(lastMsg.toolCall.args)})${COLORS.reset}`);
          break;
        case 'tool_result':
          console.log(`  ${COLORS.cyan}TOOL:${COLORS.reset} ${lastMsg.content}`);
          break;
        case 'response':
          console.log(`  ${COLORS.green}AGENT:${COLORS.reset} ${lastMsg.content}`);
          break;
      }
      console.log(`         ${COLORS.dim}[checkpoint: ${p.conversation.length} messages saved]${COLORS.reset}\n`);
    }

    if (event.type === 'complete') {
      break;
    }
  }

  console.log(`${COLORS.cyan}Key insight: Each step persists the full conversation history.`);
  console.log(`If the agent crashes after tool_call, recovery has the full context`);
  console.log(`to retry just that tool call - not restart the whole conversation.${COLORS.reset}`);

  await taskSystem.shutdown();
  fs.rmSync(demoDir, { recursive: true, force: true });
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<void> {
  const scenario = process.argv[2] || 'all';

  console.log(`\n${COLORS.bgBlue}${COLORS.white}${COLORS.bright}`);
  console.log('  +================================================================+  ');
  console.log('  |              TASKFLOW SHOWCASE DEMO                            |  ');
  console.log('  |   Demonstrating Real-World Value Propositions                  |  ');
  console.log('  +================================================================+  ');
  console.log(`${COLORS.reset}\n`);

  // Ensure demo directory exists
  fs.mkdirSync(DB_PATH, { recursive: true });

  try {
    switch (scenario) {
      case 'recovery':
        await scenarioRecovery();
        break;
      case 'backpressure':
        await scenarioBackpressure();
        break;
      case 'fairness':
        await scenarioFairness();
        break;
      case 'idempotency':
        await scenarioIdempotency();
        break;
      case 'streaming':
        await scenarioStreaming();
        break;
      case 'all':
        await scenarioIdempotency();
        await waitForKeypress('Press any key for next scenario...');

        await scenarioBackpressure();
        await waitForKeypress('Press any key for next scenario...');

        await scenarioFairness();
        await waitForKeypress('Press any key for next scenario...');

        await scenarioStreaming();
        await waitForKeypress('Press any key for recovery demo (interactive)...');

        await scenarioRecovery();
        break;
      default:
        console.log(`Unknown scenario: ${scenario}`);
        console.log('Available: recovery, backpressure, fairness, idempotency, streaming, all');
        process.exit(1);
    }

    console.log(`\n${COLORS.green}${COLORS.bright}Demo complete!${COLORS.reset}\n`);
  } catch (error) {
    if ((error as any).code === 'ERR_USE_AFTER_CLOSE') {
      // Expected when user presses Ctrl+C during waitForKeypress
      console.log(`\n${COLORS.yellow}Demo interrupted.${COLORS.reset}\n`);
    } else {
      throw error;
    }
  }

  // Cleanup
  fs.rmSync(DB_PATH, { recursive: true, force: true });
}

main().catch(console.error);
