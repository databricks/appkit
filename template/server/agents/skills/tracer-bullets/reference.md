{{if .plugins.agents -}}
# Tracer bullets: reference

## Horizontal vs. vertical

**Horizontal (avoid):** build all of one layer before the next — the whole
data model, then the whole API, then the whole UI. Nothing runs end-to-end
until the last layer lands, so integration risk is discovered last and there's
nothing to demo for weeks.

**Vertical / tracer bullet (prefer):** build a thin path through every layer at
once. It handles one case, but it *runs*. Each later slice widens it.

## Worked example — "users can export a report"

1. **Slice 1 — one hardcoded row, real download.** A button calls a new
   endpoint that returns a CSV with a single hardcoded row. Demo: click the
   button, a file downloads.
2. **Slice 2 — real data, one format.** Wire the endpoint to the actual query.
   Demo: the CSV now reflects the live table.
3. **Slice 3 — the user's filters.** Pass the screen's active filters into the
   query. Demo: filtered view exports filtered data.
4. **Slice 4 — second format + empty state.** Add XLSX and a friendly message
   when there are zero rows. Demo: toggle format; export an empty result.

Each slice ships. If slice 1 can't be demoed by a person, it isn't thin
enough yet — cut it further.
{{- end}}
