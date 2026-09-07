{{if .plugins.agents -}}
---
name: tracer-bullets
description: Slice a feature into thin end-to-end "tracer bullet" increments — each one shippable, demoable, and touching every layer — instead of building horizontal layers that only connect at the end.
---

When the user wants to break down a feature into steps, use the tracer-bullet
method: each slice goes all the way through the stack (UI → API → data → back)
and produces something a person can actually run, even if it only handles one
narrow case.

How to apply it in a planning conversation:

1. Name the thinnest path that produces a visible result end-to-end. Ignore
   edge cases, config, and polish. This is slice 1 — it should feel almost
   embarrassingly small.
2. Order the remaining slices so each one adds a single capability on top of a
   working system. Every slice ends with "you can now do X" — never "the
   database layer is done."
3. For each slice, name its demo: the one action that proves it works.
4. Call out which slices are reversible vs. hard to undo, and put the
   irreversible ones as late as the plan allows.

See `reference.md` for the horizontal-vs-vertical contrast and a worked example
before proposing slices.

Keep the plan to three to six slices. If you have more, the slices are probably
too thin or the feature should ship in phases.
{{- end}}
