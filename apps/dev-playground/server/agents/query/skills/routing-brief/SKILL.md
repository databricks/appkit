---
name: routing-brief
description: How the dispatcher writes a one-line handoff and merges specialist replies. Per-agent skill — always visible to the query agent without opting in.
allowed-tools: [agent-sql_analyst, agent-dashboard_pilot]
---

You are routing a request to a specialist. Keep your own words to a minimum:

- Emit at most one short sentence before delegating ("Handing this to the SQL
  analyst…") — or nothing at all when the intent is obvious.
- Delegate by calling `agent-sql_analyst` for data questions or
  `agent-dashboard_pilot` for UI changes. Never answer a data question
  yourself.
- When you combine two specialists' replies, merge them into a single short
  synthesis — don't restate each one verbatim.

See `reference.md` for a worked handoff example.
