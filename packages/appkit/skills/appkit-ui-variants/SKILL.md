---
name: appkit-ui-variants
description: Builds a piece of UI in multiple variants, lets the developer pick one live in the browser, then finalizes the chosen variant into source
argument-hint: <what to build>
---

# UI — Build in Variants, Pick Live, Finalize

User input: $ARGUMENTS

Build the requested UI in several variants wrapped in the `<Variants>` picker,
let the developer choose one **live in the browser**, and then finalize the
chosen variant into source (removing the wrapper).

The picker lets a developer choose between several candidate UIs live in the
browser during local dev; you then finalize the chosen one into source.

**These rules govern your behavior, not your narration.** Apply every rule
silently. To the developer, speak only about what you're building and what they
need to do — never about the mechanism (the choices file, how a choice is
stored, "I read it next turn", or whether you decided to ask).

## The pieces

- **`<Variants>` / `<Variant>`** — `@databricks/appkit-ui/react`. A dev-time
  wrapper that renders one candidate at a time with a hover-revealed switcher
  (prev/next, an index pill + label) and a **Confirm** tick.
- **The recorder** — built into `@databricks/appkit`. Records the confirmed
  choice: Confirm POSTs `{ blockId, chosenIndex, label }` to
  `POST /api/ui-variants/confirm`, upserted into a JSONL file keyed by `blockId`.
  It runs automatically in dev and drops out of production on its own — there's
  nothing to set up.
- **Choices file** — `node_modules/.databricks/appkit/.appkit-ui-choices.jsonl`,
  gitignored. A **keyed store: one line per `<Variants>` blockId** (not an append
  log) — re-confirming a variant replaces that block's line, so the file always
  reflects the current choice:
  `{ "ts": "...", "blockId": "hero-cta", "chosenIndex": 1, "label": "Solid" }`.
  Its path is relative to the dev server's cwd, not the repo root, so
  **discover** it (finalize step 4) rather than assuming a fixed location.

## 1. Understand the request

Work out what to build (a component, a section, a page) and where it lives, then
pick the natural target file (e.g. a `*.route.tsx` or a component under
`src/components/…`), and decide the block breakdown before authoring. Two rules
shape this step:

- **Ask for _what_ and _where_; build for _how it looks_.** Before generating,
  ask at most one or two questions **only if the answer changes the build** —
  ambiguous target/surface, an unclear axis of variation, or real-vs-placeholder
  data on a data screen. Do **not** ask appearance/taste questions ("bold or
  minimal?", "which color?"); make one bold and one minimal instead. If the
  request is clear enough, skip questions. Never turn it into a checklist.
- **One `<Variants>` block = one independent decision** — default to one block
  per distinct section the user names (a hero + about page → two blocks), and
  **default 3 meaningfully different variants per block**.

## 2. Author the variants

Wrap each section's candidates in its own `<Variants>` block, following the
authoring rules below. Note the **file path + every `blockId`** — you need them
to finalize.

- **MUST** treat one `<Variants>` block as **one independent decision** and
  default to **one block per distinct section/region** the user names. A page
  with a hero and an about-us section is **two** blocks (`blockId="hero"`,
  `blockId="about"`), so the developer chooses each section independently. Use a
  single whole-page block **only** when the user asks for whole-page options or
  the sections must move together as one unit.
- **MUST** give every `<Variants>` block a **stable, unique `blockId`** within its
  file. Duplicate ids are ambiguous — refuse and disambiguate.
- **MUST** wrap each candidate in `<Variant label="…">` with a short, distinct
  label. The label is shown in the switcher and recorded on confirm.
- **SHOULD** default to **3 variants** unless the user asks for a specific
  count. Make them meaningfully different (layout / emphasis / density).
- Keep each variant self-contained: imports it needs should already be present
  so finalizing to any one of them leaves the file valid.
- **Layout:** `<Variants>` defaults to block layout (full-width, stacking) —
  correct for sections, heroes, and pages. Pass `layout="inline"` only when
  wrapping a small inline element such as a single button.

One block per section, each candidate a labelled `<Variant>`:

```tsx
import { Variants, Variant } from "@databricks/appkit-ui/react";

// "page with a hero and an about-us section" → one block per section
<Variants blockId="hero">
  <Variant label="Centered">…hero A…</Variant>
  <Variant label="Split with stats">…hero B…</Variant>
  <Variant label="Minimal">…hero C…</Variant>
</Variants>

<Variants blockId="about">
  <Variant label="Two column">…about A…</Variant>
  <Variant label="Timeline">…about B…</Variant>
  <Variant label="Team grid">…about C…</Variant>
</Variants>
```

## 3. Ensure the recorder is running

- The recorder runs automatically in dev — no setup needed.
- Confirm the dev server is running so the browser can POST the choice.

## 4. Hand off to the developer

Tell the developer to make the choice in the browser:

> Flip through the variants in the browser (hover the block to reveal the
> switcher) and click **Confirm** on the one you want.

Then get the "I've chosen" signal — the developer's next message.

**The signal is turn-based.** Do **not** start a background watcher. The confirm
is recorded to the file; read it on your next turn. How to prompt for it:

- If your tool has an interactive question prompt **and** the developer is in an
  active session, you MAY ask via that prompt — options like **"I've picked —
  finalize" / "Still deciding" / "Cancel"** — to save them typing.
- Otherwise, ask in plain text and read the file on a later turn.

Two hard rules: the question **must** carry a "still deciding / later" option so
it never blocks the developer; and only ask when someone is there to answer — if
unsure, use plain text. If the developer says "done" but no line exists for the
block yet, they haven't clicked Confirm — ask them to, don't finalize nothing.

## 5. Finalize when the developer says they've chosen

1. When the developer says they've chosen, **discover the choices file** (path
   is relative to the dev server's cwd):
   ```bash
   f=$(find . -path '*/node_modules/.databricks/appkit/.appkit-ui-choices.jsonl' 2>/dev/null | head -1)
   cat "$f"   # find the line for your block's blockId
   ```
2. For the line matching your block's `blockId`, **reconcile `chosenIndex` against
   `label`:** check the `<Variant>` at `chosenIndex` (zero-based) still has the
   recorded `label`. If they don't match, the file was edited after confirm —
   prefer the `<Variant>` whose `label` matches; if none matches, stop and ask
   the developer to re-confirm.
3. Find the `<Variants blockId="<that id>">` block and **replace the whole block with
   the chosen `<Variant>`'s inner JSX** — remove the `<Variants>`/`<Variant>`
   wrapper, drop the now-unused import if nothing else uses it, reconcile
   surrounding code, then format/lint the file
   (`pnpm check:fix`, or `pnpm exec oxlint --fix <file> && pnpm exec oxfmt --write <file>`).
4. **Remove the consumed line** for that `blockId` from the choices file. Match the
   `blockId` structurally (not a loose substring) so a label containing the text
   can't delete the wrong line:
   `tmp=$(mktemp); jq -Rc 'fromjson? | select(.blockId != "<that id>")' "$f" > "$tmp" && mv "$tmp" "$f"`.
5. Confirm the finalized UI back to the developer.

## 6. Wrap up

Offer to iterate (new variants, tweaks) if the developer wants another round.

## Edge cases

- **Developer confirms before you ask.** The choice waits in the file; read it
  whenever you next act.
- **Developer changed their mind.** The store is keyed by `blockId`, so
  re-confirming overwrites the previous line. Read whatever line is there now.
- **Endpoint absent (prod build / feature off).** The switcher still works as a
  viewer; Confirm shows "Recorder unavailable". Nothing is recorded — nothing to
  finalize.
- **Duplicate `blockId` in a file.** Ambiguous — refuse to finalize automatically;
  ask which block, or re-author with unique ids.

## Keeping it out of production

`<Variants>` is dev-time scaffolding. Always finalize (or remove) every block
before a production build — a leftover block ships the dev-only picker to
production.

## Anti-patterns
- Wrapping several sections in one `<Variants>` block (forces whole-page combos,
  hides most combinations) — one block per section instead.
- Cosmetic-only variants (same layout, tweaked padding) — make them meaningfully
  different or don't offer a choice.
- Starting a background watcher/monitor to catch the confirm — the flow is
  turn-based on purpose; read the file when the developer says they're done.
- Leaving the `<Variants>` wrapper in source after a choice — always finalize
  (or remove) it; a leftover block ships the dev-only picker to production.
- Forgetting to clear the consumed choices line after finalizing.
