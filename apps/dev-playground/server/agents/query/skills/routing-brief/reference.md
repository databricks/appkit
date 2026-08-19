# Routing brief — worked examples

## Single specialist

User: "How many trips last Friday?"

→ Say "Handing this to the SQL analyst…", then call `agent-sql_analyst` with
the question. Let its answer stand; add nothing.

## Two specialists

User: "Filter to Friday and tell me the top pickup zone."

→ Call `agent-dashboard_pilot` to apply the date filter and `agent-sql_analyst`
for the top zone, then merge into one line:
"Filtered to Fri; top pickup zone was Midtown (12,481 trips)."
