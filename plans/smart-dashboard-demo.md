# Plan: Smart-Dashboard demo route (retires `agent-app`)

## Goal

Replace `apps/agent-app` with a **new `/smart-dashboard` route inside
`dev-playground`** that doubles as the integration test for every feature
in the agents-plugin v2 stack. An analytics dashboard (NYC Taxi data)
where multiple agents help the user interpret, filter, and highlight data
in real time, plus a hidden-by-default **Stream Inspector** for observability
of the SSE pipeline.

The route is **the demo** that makes branches 4/5/6 reviewable end-to-end:
fold-based markdown agents, `createAgent`, `fromPlugin`, sub-agent
delegation, human-in-the-loop approval, MCP host policy, DOS limits,
ephemeral agents — all exercised by one app.

## Locked decisions

| Topic | Choice |
|---|---|
| Location | `apps/dev-playground/client/src/routes/smart-dashboard/` + server wiring in `apps/dev-playground/server/index.ts`. **No new app.** |
| Fate of `agent-app` | **Delete.** Replaced by this route as the sole end-to-end demo. |
| Domain / data | NYC Taxi samples (`samples.nyctaxi.trips`). Directly reusable from the `p3ju` prototype. |
| Agent ↔ UI protocol | **SSE tool-call args as action payload.** Agent `tool.execute` is a stub returning confirmation text; the UI reads `function_call` items from the SSE stream and mutates client state. No new primitive. |
| Interaction level | (c) emitted actions — agent can apply filters, highlight time ranges, focus charts, save views. No server-side dashboard mutation. |
| Agents (3 + dispatcher) | `query` (markdown dispatcher), `sql_analyst` (code, `fromPlugin(analytics)` + `save_view`), `dashboard_pilot` (code, UI action tools), `insights` + `anomaly` (ephemeral markdown, auto-fire on KPI load) |
| Sub-agent definition style | **Code** for `sql_analyst` / `dashboard_pilot`. Markdown narrative is already covered by the three markdown agents; code demonstrates the `createAgent` + `fromPlugin` + inline `tool()` engineer path that dev-playground currently doesn't exercise. |
| Approval flow | `save_view({ name, description? })` annotated `destructive: true`. Fires the HITL card. Server handler is a stub. |
| Stream inspector | Slide-in right drawer, toggled by ⌘K or a small floating icon. Shows filtered SSE event timeline with args + expandable JSON. **Demo-scoped** — lives under the route directory, not promoted to `appkit-ui`. |
| Merge strategy | **Into `agent/v2/6-apps-docs`** as the "integration test" payoff of the stack. Not a follow-up PR. |
| Dev-playground character | Accept that it grows from "feature grab-bag" into "feature grab-bag + one flagship demo route." The route lives in its own subdirectory and doesn't leak into other routes. |

## Non-goals (this iteration)

- Real Databricks AI/BI dashboard embedding.
- Server-side dashboard state (named views shared across users).
- WebSocket / bidirectional agent ↔ UI channel. SSE-only.
- Agents reading dashboard state via tool calls. State flows to the agent
  via system-prompt context injection only (static).
- Promoting the stream inspector into `appkit-ui`. Follow-up if the demo lands.
- MCP hosted tools in this route. The v2 stack already has MCP coverage
  elsewhere; not worth the extra env-var setup for this demo.

## What exists today (prototype to port)

Source: `/Users/mario.cadenas/.cursor/worktrees/app-kit/p3ju/apps/smart-dashboard/`

- **Server** (`server.ts`, 97 lines) — `query` agent code-defined with
  `apply_filter` + `highlight_period` tools + `fromPlugin(analytics)`.
- **Markdown agents** (`config/agents/`) — `anomaly.md` and `insights.md`,
  ephemeral, `maxSteps: 1`, return JSON.
- **SQL queries** (`config/queries/`) — `dashboard_kpis.sql`,
  `dashboard_trips_over_time.sql`, `dashboard_fare_distribution.sql`,
  `dashboard_top_zone.sql`.
- **Client** (`src/`, 16 files, 1,544 lines) — `App.tsx`, component set
  (active-filters, agent-sidebar, anomaly-card, fare-chart, insight-card,
  kpi-cards, query-section, trip-chart), hooks (`use-agent-stream`,
  `use-action-dispatcher`, `use-chart-colors`, `use-dashboard-data`).

**~80% copy-forward.** The 20% new is stream inspector, multi-agent
delegation, dashboard-context injection, `focus_chart`, approval card,
polish.

## What this plan adds

### 1. Stream Inspector (NEW)

Hidden-by-default right-edge drawer showing the SSE timeline of the latest
run. Reviewers see tool-calls, message deltas, sub-agent invocations, and
approval gates inline — the "inside the black box" view.

- **Trigger:** ⌘K (macOS) / Ctrl+K, or a small debug icon in the bottom-right.
- **Layout:** 420px right drawer, backdrop-blur, slides in.
- **Content per event:** timestamp (ms relative to stream start), event
  type, tool name + args table when it's a function call, collapsible
  full-JSON view.
- **Filter chips:** `all` / `tool calls` / `messages` / `approvals` / `sub-agents`.
- **Implementation:** extend `use-agent-stream` to push every event into a
  module-level store; new `<StreamInspector>` component consumes it.
- **Scope:** session-only. No persistence, no export.

### 2. Approval-gate demo path

One destructive tool so HITL fires visibly:

- `save_view({ name, description? })` annotated
  `{ destructive: true, readOnly: false }`.
- Prompt it with *"save this as 'High-fare Friday 2016'"*.
- UI renders a rich `<ApprovalCard>` with the view name, description,
  current filters + highlights summary, annotations chip.
- Approve → tool returns success, agent confirms. Deny → agent receives
  the denial string, apologises, replans.

Handler is a stub (console.log + return).

### 3. Dashboard context injection (static)

Every chat message gets a prefix block describing what the user is looking
at: active filters, highlight ranges, current timerange.

- `buildDashboardContext(filters, highlights): string` utility.
- `use-agent-stream.send(message, { contextPrefix })` signature extension.
- `<QuerySection>` composes the prefix before each send.

Pure UX change. No new AppKit primitive.

### 4. Multi-agent delegation (upgrades the `query` agent)

Prototype's `query` is a flat agent with four tools. Upgrade:

- `query` (markdown dispatcher) — decides which specialist to call, never
  calls tools directly.
- `sql_analyst` (code) — tools: `...fromPlugin(analytics)`, `save_view`.
- `dashboard_pilot` (code) — tools: `apply_filter`, `highlight_period`,
  `focus_chart`.

Dispatcher exposes `agent-sql_analyst` and `agent-dashboard_pilot` as
sub-agent tools. Default agent: `query`.

This demonstrates:
- Sub-agent delegation (`agents:` in def)
- `fromPlugin` + inline `tool()` in code (`sql_analyst`)
- Tool-only sub-agent with no plugin deps (`dashboard_pilot`)
- The flat-vs-delegated trade-off (risk: extra round-trip latency — see Risks)

### 5. New UI action tool: `focus_chart({ chart_id })`

Scrolls to the named chart and pulses it. Chart IDs:
`trips_over_time`, `fare_distribution`, `kpis`.

- `tool()` handler returns a confirmation string.
- Client `useFocusRegistry` hook: chart components register refs by id.
- `use-action-dispatcher` listens for `focus_chart` function_call events
  and triggers the pulse animation.

Zero server logic. Pure action-dispatch demo.

### 6. Polish

- `<ApprovalCard>` renders annotations prominently (red badge for
  `destructive: true`) plus filter/highlight context.
- KPI cards use shimmer loading instead of `isLoading` text.
- Error toasts when SQL fails / agent errors / model endpoint 4xx/5xx.
- Keyboard: ⌘K (inspector), ⌘L (focus chat input), `Esc` (close drawer).
- Top-of-route hero: "Smart Dashboard — NYC Taxi analytics, powered by
  3 AI agents" with tiny indicators for each agent's state.

## Architecture notes

### The agent → UI action pattern

The prototype's core insight: **the agent's tool-call JSON is the action
payload.** No new AppKit primitive.

```
Agent emits:   tool_call { name: "apply_filter", args: { field: "date", ... } }
              ↓ (via SSE response.output_item.added)
Client reads:  SSEEvent { item: { type: "function_call", name, arguments } }
Client applies: setFilters(deriveFiltersFromArgs(args))
Server tool:   execute() returns confirmation text for the LLM log
```

Benefits preserved:
- Agent control flow: LLM sees confirmation, plans next step.
- Client latency: UI updates as tokens stream.
- Security: no new attack surface; existing SSE pipeline already authed.
- Observability: stream inspector sees every action inline with everything else.

### Dashboard state flow

```
User action ─→ useState (filters, highlights) ─→ useDashboardData() ─→ SQL
                              ↑                                           ↓
                              └──── tool_call dispatch ←──── SSE ←──── agent
                                                                          ↑
                              buildDashboardContext() ─────→ send() ──────┘
```

One-way reactive loop. Simple, testable.

### File layout (target)

```
apps/dev-playground/
  config/
    agents/
      query/agent.md              # dispatcher (NEW)
      insights/agent.md           # ported from prototype
      anomaly/agent.md            # ported from prototype
      assistant/agent.md          # existing — unchanged
      autocomplete/agent.md       # existing — unchanged
    queries/                      # NEW if not present; check
      dashboard_kpis.sql
      dashboard_trips_over_time.sql
      dashboard_fare_distribution.sql
      dashboard_top_zone.sql
  server/
    index.ts                      # add sql_analyst + dashboard_pilot,
                                  # wire apply_filter, highlight_period,
                                  # focus_chart, save_view
  client/
    src/
      routes/
        smart-dashboard.route.tsx # NEW route entry (registers under /smart-dashboard)
        smart-dashboard/          # NEW subdirectory
          components/
            active-filters.tsx    # ported
            agent-sidebar.tsx     # ported + inspector toggle
            approval-card.tsx     # NEW
            anomaly-card.tsx      # ported
            fare-chart.tsx        # ported
            insight-card.tsx      # ported
            kpi-cards.tsx         # ported + shimmer
            query-section.tsx     # ported + dashboard-context injection
            stream-inspector.tsx  # NEW
            trip-chart.tsx        # ported + focus-pulse
          hooks/
            use-action-dispatcher.ts  # ported + focus_chart + save_view
            use-agent-stream.ts       # ported + context-prefix + inspector feed
            use-chart-colors.ts       # ported
            use-dashboard-data.ts     # ported
            use-focus-registry.ts     # NEW
            use-stream-inspector.ts   # NEW
          lib/
            dashboard-context.ts      # NEW (buildDashboardContext)
```

## Implementation stages

Each stage independently shippable. Stop at Stage 2 for MVP demo; go
through Stage 5 for wow.

### Stage 0 — Port prototype + retire agent-app (2h)

- [ ] Port `config/queries/*.sql` into `apps/dev-playground/config/queries/`
- [ ] Port `config/agents/anomaly.md` + `insights.md` into folder layout:
      `config/agents/anomaly/agent.md`, `config/agents/insights/agent.md`
- [ ] Port 16 client files into `client/src/routes/smart-dashboard/`
- [ ] Register the route in TanStack Router (`smart-dashboard.route.tsx`)
- [ ] Add `query` markdown agent + `sql_analyst`/`dashboard_pilot` code
      agents to `server/index.ts`, including the ambient tools
- [ ] Delete `apps/agent-app/`
- [ ] Grep repo for `agent-app` references (docs, template, scripts,
      `docs/docs/plugins/agents.md`, tests)
- [ ] Verify `pnpm --filter=dev-playground dev` boots, `/smart-dashboard`
      renders the dashboard, KPIs load, default chat works

### Stage 1 — Dispatcher + sub-agents (3h)

- [ ] Split the flat `query` agent into `query` dispatcher + `sql_analyst`
      + `dashboard_pilot`
- [ ] Dispatcher prompt: "decide which specialist to call; do not call
      tools directly"
- [ ] `query.md` has `agents: [sql_analyst, dashboard_pilot]` frontmatter
- [ ] Benchmark TTFT against the flat agent — if p90 > 3s, revert to flat
      and use delegation only for pilot commands

### Stage 2 — Destructive action + approval card (3h)

- [ ] Implement `save_view({ name, description? })` tool with
      `annotations: { destructive: true }`
- [ ] Build `<ApprovalCard>`: name/description fields visible, filters +
      highlights context block, red destructive chip, approve/deny
- [ ] Wire to `POST /api/agent/approve`
- [ ] Deny path: confirm agent receives denial string and gracefully
      replans

### Stage 3 — Dashboard context injection + `focus_chart` (2h)

- [ ] `lib/dashboard-context.ts` — `buildDashboardContext(filters, highlights)`
- [ ] `use-agent-stream.send` accepts `{ contextPrefix }`
- [ ] `<QuerySection>` composes prefix before every send
- [ ] `focus_chart` tool + `use-focus-registry` hook
- [ ] Chart components register refs, pulse animation on focus

### Stage 4 — Stream Inspector (4h)

- [ ] `use-stream-inspector` — module-level event store, ⌘K toggle, clear-on-new-run
- [ ] `use-agent-stream` pushes every SSE event into the store
- [ ] `<StreamInspector>` component — drawer, filter chips, event timeline,
      expandable JSON, per-event timestamp relative to stream start
- [ ] Focus trap, `Esc` to close, restore focus on close
- [ ] Floating debug icon in bottom-right (discoverability alongside ⌘K)

### Stage 5 — Polish (2h)

- [ ] KPI shimmer loading
- [ ] Error toasts for SQL failures, agent errors
- [ ] Keyboard shortcuts: ⌘K, ⌘L, `Esc`
- [ ] Route-level README: `client/src/routes/smart-dashboard/README.md` —
      architecture, demo script, known limitations
- [ ] `docs/docs/plugins/agents.md` — add a "See it all together" pointer

### Stage 6 — Demo script + rehearsal (1h)

- [ ] `DEMO.md` at repo root or route directory — step-by-step, 15 min,
      one block per feature
- [ ] Dry-run with someone who hasn't seen it; flag rough edges

**Total: ~17h focused.** Realistic wall-clock: ~2.5 days.

## Acceptance criteria

- [ ] `pnpm --filter=dev-playground dev` boots and `/smart-dashboard` renders
- [ ] "show me fares above $50" → filter applied, charts update
- [ ] "highlight November 2016" → trip chart gets a shaded band
- [ ] "focus on the fare distribution" → fare chart scrolls into view + pulses
- [ ] "save this as 'high-fare-fridays'" → approval card appears; deny → apology; approve → view logged
- [ ] Default page load: insights + anomalies populate within ~5s of KPI data
- [ ] ⌘K opens stream inspector; filter chips work; tool-call events show args + result
- [ ] Delegation: "compare Dec vs Nov fares" routes to `sql_analyst`;
      "highlight peak hours" routes to `dashboard_pilot`
- [ ] `apps/agent-app/` deleted; `rg "agent-app"` across repo returns only
      historical CHANGELOG entries
- [ ] `pnpm --filter=appkit test` still passes (no regressions in the v2 stack)

## Git

- Branch: **`agent/v2/6-apps-docs`** (this stack's tip).
- Ideally one commit per stage, for reviewable chunks.
- Rebase 5→4 shouldn't be needed; this is additive on top of the stack.
- After the stack merges, the work stays as-is on `main`.

## Risk

- **Prototype drift.** Built against AppKit 0.24.0 vendored tgz; current
  stack is also 0.24.0 but we've refactored internals (MCP connector move,
  helper extractions). Risk: minor import/type tweaks on port. Mitigation:
  Stage 0 is port-and-boot first, nothing added until green.

- **Stream inspector scope creep.** Easy to make a week of work. Mitigation:
  v1 is "dump JSON events with filter chips." No search, no diff, no export.

- **Delegation latency.** Dispatcher → sub-agent is 2 model round-trips. May
  feel laggier than prototype's flat agent. Mitigation: benchmark in Stage 1;
  fall back to flat if p90 TTFT > 3s.

- **Dev-playground bloat.** Adding ~1,500 client lines in a subdirectory.
  Mitigation: everything lives under `routes/smart-dashboard/`; other routes
  unaffected; playground's other routes unchanged.

- **v2 stack size.** Branch 6 gets bigger. Acceptable trade-off for having
  a single end-to-end integration demo that reviewers can run and every
  feature is visible.

## Next step

Stage 0 port + boot verification. One commit on `agent/v2/6-apps-docs`:

```
feat(dev-playground): port Smart Dashboard as /smart-dashboard route; retire agent-app

Ports the p3ju Smart Dashboard prototype into apps/dev-playground as a new
route. Migrates markdown agents to folder layout. Deletes apps/agent-app
(superseded by this demo).

Verifies that the route boots, KPIs load from samples.nyctaxi.trips, and
the flat `query` agent answers and applies filters.

Stages 1-6 (delegation, approval, context injection, stream inspector,
polish, demo script) land as follow-up commits on the same branch.
```

If approved, I run Stage 0, report the diff size and any porting surprises,
then proceed stage by stage.
